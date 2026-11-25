/**
 * subagent-native：把本机原生 codex / claude CLI 注册成 DSH 的 subagent provider，
 * 并可选地在框架侧兜底触发（模型不主动派时由插件派）。
 *
 * 为什么是 provider 而不是自己 spawn 完再注入（auto-delegate 的老路）：
 * 注册成 provider 后，官方那一整套（catalog、完成通知、容量限制、团队任务板、
 * subagent/start|end 事件）全部生效，同时通道成本走原生 CLI。
 *
 * 2026-11-24 实测：原生 codex_exec 在中转站按 1 折计费（$0.05423 → $0.00542）；
 * DSH 自带 provider 因自称 deepseek-harness 被按标准价收。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildBrief } from './lib/brief.js';
import { budgetUsage, checkBudget, todaySpend } from './lib/budget.js';
import { buildClaudeArgs, CLAUDE_READ_ONLY_MODE, runClaudeOnce } from './lib/claude-run.js';
import { buildCodexArgs, runCodexOnce } from './lib/codex-run.js';
import { applyThreshold, countPaths, estimateDifficulty } from './lib/difficulty.js';
import { captureBaseline, describeChanges, diffSince } from './lib/git-snapshot.js';
import { buildRecord, createHistoryStore, estimateFailedCost, preview, projectCost, summarize } from './lib/history.js';
import { claudeEffectiveConfig, codexEffectiveConfig } from './lib/native-config.js';
import { DEFAULT_RULES, decideByRules, validateRules } from './lib/rules.js';
import { extractPlan, shouldRelay } from './lib/relay.js';
import { createDecisionLog } from './lib/decisions.js';
import {
  CLAUDE_PERMISSION_MODES,
  LEVELS,
  MAX_PLAN_TIMEOUT_MINUTES,
  PACKAGE_NAME,
  mergeConfig,
  normalizePatch,
  resolveConfig,
} from './lib/config.js';
import { checkCwd } from './lib/guard.js';
import { createLedger } from './lib/ledger.js';
import { renderRouteLine } from './lib/route-line.js';
import { splitTargets } from './lib/split.js';

const CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
});

/** 内存里保留的判定条数（文件另由 decisionLog 轮转）。 */
const DECISION_MEMORY = 200;

/** 官方完成通知的开头：这类用户消息不能当作新任务再判定一次。 */
const NOTICE_PREFIXES = ['Background subagent ', 'Subagent ', '【subagent-native】'];

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** pre-step 的 payload.messages 在回合中途是空的，兜底读会话尾部事件。 */
function lastUserTextFromSession(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return '';
  try {
    const end = Number(session.seq);
    if (!Number.isFinite(end) || end <= 0) return '';
    const events = session.snapshotEvents(Math.max(0, end - 400), end);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'user/message') continue;
      const kind = event.data?.source?.kind;
      if (kind && kind !== 'user') continue;
      const text = contentText(event.data?.content);
      if (text) return text;
    }
  } catch {
    /* 读不到就当没有 */
  }
  return '';
}

function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export { resolveConfig };


export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  if (!cfg.enabled) {
    ctx.logger?.info?.('[subagent-native] 已按配置停用');
    return;
  }

  const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
  const dataDir = cfg.history.dir || path.join(profileDir, '.subagent-native');
  const runsFile = path.join(dataDir, 'runs.jsonl');
  const decisionsFile = path.join(dataDir, 'decisions.jsonl');
  const store = createHistoryStore({ file: runsFile, limit: cfg.history.limit });
  let runs = store.load();
  const decisionLog = createDecisionLog({ file: decisionsFile });
  let decisions = decisionLog.load(DECISION_MEMORY);
  // 预算账本与展示用历史分开：清历史/关历史/裁剪都不影响预算
  const ledgerFile = path.join(dataDir, 'ledger.jsonl');
  const ledger = createLedger({ file: ledgerFile });
  const seeded = ledger.seedFromHistory(runs);

  const diag = (line) => {
    try {
      ctx.logger?.info?.(`[subagent-native] ${line}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  const appendDecision = (record) => {
    decisions.push(record);
    if (decisions.length > DECISION_MEMORY) decisions = decisions.slice(-DECISION_MEMORY);
    decisionLog.append(record);
  };

  /** 预算闸门：返回 { ok, spent, limit, remaining, reason }。 */
  /** 在飞运行：预算要能看到「已启动、还没结算」的支出，否则并发的几份会一起放行。 */
  const inFlight = new Map();
  const inFlightTotal = () => {
    let total = 0;
    for (const item of inFlight.values()) total += item.projected ?? 0;
    return Math.round(total * 1e6) / 1e6;
  };
  const budgetState = (projected = 0) =>
    checkBudget({ spent: ledger.today(), inFlight: inFlightTotal(), projected, budget: cfg.budget });

  /** 设置页读的完整快照。 */
  const configSnapshot = () => {
    const gate = budgetState();
    return {
      auto: {
        enabled: cfg.auto.enabled,
        mode: cfg.auto.mode,
        thresholds: { ...cfg.auto.thresholds },
        minPromptChars: cfg.auto.minPromptChars,
        yield: cfg.auto.yield,
        yieldMinutes: cfg.auto.yieldMinutes,
      },
      team: { enabled: cfg.team.enabled, maxParallel: cfg.team.maxParallel, minTargets: cfg.team.minTargets },
      relay: {
        enabled: cfg.relay.enabled,
        planChannel: cfg.relay.planChannel,
        executeChannel: cfg.relay.executeChannel,
        minDifficulty: cfg.relay.minDifficulty,
        planTimeoutMinutes: cfg.relay.planTimeoutMinutes,
      },
      budget: {
        enabled: cfg.budget.enabled,
        dailyUsd: cfg.budget.dailyUsd,
        spentToday: gate.spent,
        remaining: gate.ok && gate.limit > 0 ? gate.remaining : null,
        usage: budgetUsage(gate),
      },
      codex: { providerName: cfg.codex.providerName, model: cfg.codex.model, effort: cfg.codex.effort, sandbox: cfg.codex.sandbox },
      claude: {
        providerName: cfg.claude.providerName,
        model: cfg.claude.model,
        effort: cfg.claude.effort,
        permissionMode: cfg.claude.permissionMode,
      },
      history: { limit: cfg.history.limit },
      brief: { maxChars: cfg.brief.maxChars, planChars: cfg.brief.planChars },
      tools: { enabled: cfg.tools.enabled },
      // 成本估算用的价目（每百万 token）；custom=true 表示被用户覆盖过，不是内置渠道价
      pricing: {
        codex: { ...cfg.pricing.codex },
        claude: { ...cfg.pricing.claude },
      },
      options: {
        difficulties: LEVELS,
        claudeEfforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
        codexEfforts: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        claudePermissionModes: CLAUDE_PERMISSION_MODES,
        modes: ['observe', 'dispatch'],
      },
    };
  };

  /** 设置页写入：只接受白名单字段，其余原样保留。 */
  const applyConfigPatch = async (patch) => {
    const editor = ctx.get('configEditor');
    if (!editor || typeof editor.edit !== 'function') throw new Error('configEditor 不可用');
    const entry = (editor.entries?.() ?? []).find((item) => item?.options?.name === PACKAGE_NAME);
    if (!entry) throw new Error('找不到 subagent-native 的 loader 条目');

    const next = normalizePatch(patch);
    await editor.edit(entry, (current = {}, inherited = {}) => mergeConfig(current, inherited, next));
    return next;
  };

  const recordRun = (input) => {
    // 价目按通道解析后传进去：内置值是某个中转站的渠道价，用户可在 config.pricing 覆盖
    const record = buildRecord({ ...input, pricing: cfg.pricing?.[input.channel] });
    // 没拿到 usage 的运行（取消/超时/异常退出）按「同通道每秒成本 × 本次耗时」外推：
    // 直接取中位数会把超时这类长运行低估 6–80 倍，而它们恰恰最贵
    if (record.costEstimate && record.costEstimate.usd == null) {
      const fallback = estimateFailedCost(runs, input.channel, record.durationMs, {
        capMs: (input.timeoutMinutes ?? 20) * 60_000,
      });
      if (fallback != null) {
        record.costEstimate = { ...record.costEstimate, usd: fallback, estimated: true };
      }
    }
    // 账本先记：预算不依赖历史开关、裁剪或清空
    ledger.add({
      at: record.endedAt ?? Date.now(),
      channel: record.channel,
      usd: record.costEstimate?.usd ?? 0,
      estimated: Boolean(record.costEstimate?.estimated),
    });
    if (!cfg.history.enabled) return;
    runs.push(record);
    if (runs.length > cfg.history.limit) runs = runs.slice(-cfg.history.limit);
    store.append(record);
    diag(
      `run ${record.provider} ${record.durationMs}ms ${record.stopReason} tokens=${JSON.stringify(record.usage)} cost≈$${record.costEstimate.usd ?? '?'}${record.costEstimate.estimated ? '(估算)' : ''}`,
    );
  };

  const subagents = ctx.get('subagents');
  const subprocess = ctx.get('subprocess');
  const canDispatch = Boolean(subagents && typeof subagents.registerProvider === 'function' && subprocess && typeof subprocess.spawn === 'function');
  if (!canDispatch) {
    ctx.logger?.warn?.('[subagent-native] subagents/subprocess 服务不可用，provider 与兜底触发都不会启用');
  }

  // ── 通道定义 ────────────────────────────────────────────────────────
  const channels = {
    codex: {
      name: cfg.codex.providerName,
      enabled: cfg.codex.enabled,
      model: cfg.codex.model,
      effort: cfg.codex.effort,
      permissionMode: null,
      timeoutMinutes: cfg.codex.timeoutMinutes,
      graceMs: cfg.codex.graceMs,
      buildArgs: ({ cwd, readOnly }) =>
        buildCodexArgs({
          cwd,
          model: cfg.codex.model,
          effort: cfg.codex.effort,
          sandbox: cfg.codex.sandbox,
          extraArgs: cfg.codex.extraArgs,
          readOnly,
        }),
      run: (options) => runCodexOnce({ ...options, command: cfg.codex.command || 'codex' }),
    },
    claude: {
      name: cfg.claude.providerName,
      enabled: cfg.claude.enabled,
      model: cfg.claude.model,
      effort: cfg.claude.effort,
      permissionMode: cfg.claude.permissionMode,
      timeoutMinutes: cfg.claude.timeoutMinutes,
      graceMs: cfg.claude.graceMs,
      buildArgs: ({ readOnly }) =>
        buildClaudeArgs({
          model: cfg.claude.model,
          effort: cfg.claude.effort,
          permissionMode: cfg.claude.permissionMode,
          extraArgs: cfg.claude.extraArgs,
          readOnly,
        }),
      run: (options) => runClaudeOnce({ ...options, command: cfg.claude.command || 'claude' }),
    },
  };

  const simplifyStop = (reason) =>
    reason === 'completed' ? 'completed' : reason === 'aborted' ? 'aborted' : 'error';

  const makeProvider = (channelKey) => {
    const channel = channels[channelKey];
    return {
      name: channel.name,
      capabilities: CAPABILITIES,
      inheritsParentContext: false,
      async start(request) {
        request?.signal?.throwIfAborted();
        const startedAt = Date.now();
        const id = randomUUID();

        // 预算闸门：在飞 + 本次预占一起算，避免并发的几份在结算前把额度放穿
        const projected = projectCost(runs, channelKey) ?? 0;
        const gate = budgetState(projected);
        if (!gate.ok) throw new Error(`subagent-native(${channelKey}): ${gate.reason}`);
        inFlight.set(id, { channel: channelKey, projected });

        const cwd = String(request?.cwd || process.cwd());
        // 目录护栏：拒绝主目录 / 盘符根 / DSH 配置目录（子代理可写范围会远大于预期）
        const cwdVerdict = checkCwd(cwd);
        if (!cwdVerdict.ok) throw new Error(`subagent-native(${channelKey}): ${cwdVerdict.reason}`);
        const prompt = textOf(request?.prompt);
        if (!prompt.trim()) throw new Error(`subagent-native(${channelKey}): 任务内容为空`);
        const label = String(request?.label ?? '');
        const relayMatch = /^auto:relay:(plan|exec)$/.exec(label);
        const relayStage = relayMatch ? relayMatch[1] : null;
        const readOnly = relayStage === 'plan';
        const labelMatch = /^auto:([^:]+)(?::(\d+)\/(\d+))?$/.exec(label);
        const trigger = labelMatch || relayStage ? 'framework' : 'model';
        const fanout = labelMatch?.[2] ? { index: Number(labelMatch[2]), total: Number(labelMatch[3]) } : null;

        const cancelRef = {};
        const spawnFn = (spec) => subprocess.spawn(spec);
        // 运行前快照：之后用它回答「到底改了哪些文件」（非 git 目录返回 null）
        const baseline = await captureBaseline({ spawn: spawnFn, cwd });
        const promise = channel.run({
          spawn: spawnFn,
          args: channel.buildArgs({ cwd, readOnly }),
          cwd,
          prompt,
          timeoutMinutes: channel.timeoutMinutes,
          graceMs: channel.graceMs,
          signal: request?.signal,
          onCancel: (fn) => {
            cancelRef.cancel = fn;
          },
        });

        const run = {
          id,
          result: promise.then(
            async (value) => {
              inFlight.delete(id);
              // 运行后对比：把客观改动清单附到结果里，并写进历史
              const diff = await diffSince({ spawn: spawnFn, cwd, baseline });
              // 配置留空时模型/强度由 CLI 原生配置决定，日志里要记生效值
              const effective = channelKey === 'codex' ? codexEffectiveConfig() : claudeEffectiveConfig();
              recordRun({
                id,
                startedAt,
                endedAt: Date.now(),
                channel: channelKey,
                provider: channel.name,
                model: channel.model || effective.model,
                effort: channel.effort || effective.effort,
                permissionMode: readOnly && channelKey === 'claude' ? CLAUDE_READ_ONLY_MODE : channel.permissionMode,
                cwd,
                trigger,
                fanout,
                relay: relayStage,
                parentSession: request?.parent?.id,
                prompt,
                answer: value.answer,
                usage: value.usage,
                stopReason: value.stopReason,
                exitCode: value.exitCode,
                eventCount: value.eventCount,
                problems: value.problems,
                stderrTail: value.stderrTail,
                timeoutMinutes: channel.timeoutMinutes,
                git: diff
                  ? { changedFiles: diff.changedFiles, untrackedAdded: diff.untrackedAdded, stat: diff.stat }
                  : null,
              });
              const diagnostic = value.problems?.length ? value.problems.slice(0, 5).join('；') : undefined;
              const changeNote = diff
                ? describeChanges(diff)
                : baseline
                  ? '\n\n## 改动清单（git）\n- 未能取得对比结果'
                  : '\n\n## 改动清单（git）\n- 非 git 目录，无法列出改动';
              return {
                output: value.answer ? [{ type: 'text', text: `${value.answer}${changeNote}` }] : [{ type: 'text', text: changeNote }],
                ...(diagnostic ? { diagnostic } : {}),
                stopReason: simplifyStop(value.stopReason),
              };
            },
            (error) => {
              inFlight.delete(id);
              diag(`provider 运行异常：${error?.message ?? error}`);
              throw error;
            },
          ),
          async dispose() {
            try {
              cancelRef.cancel?.();
              await promise;
            } catch {
              /* 已结束 */
            }
          },
        };
        return run;
      },
    };
  };

  // 只有用户显式开启（工具或框架派发）才注册 provider：
  // 没注册时 dsh-tool-subagent 只会记一条日志、等 provider 出现再挂载，工具对模型不可见。
  const exposeProviders = cfg.tools.enabled || cfg.auto.enabled;
  if (canDispatch) {
    ctx.effect(() => {
      const disposers = [];
      if (!exposeProviders) {
        diag('未启用：不注册 provider（模型看不到子代理工具）。在设置里打开「允许模型调用」或「框架派发」后生效');
        return () => {};
      }
      for (const key of ['codex', 'claude']) {
        if (!channels[key].enabled) continue;
        disposers.push(subagents.registerProvider(makeProvider(key)));
        diag(`已注册 provider ${channels[key].name}`);
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* 已撤销 */
          }
        }
      };
    });
  }

  // ── 框架兜底触发 ────────────────────────────────────────────────────
  const states = new Map(); // agentId -> { lastPromptKey, runsThisTurn, lastRunAt, current, difficulty }
  const cleanups = new Map();
  let routeContextSeq = 0;

  const stateFor = (agentId) => {
    let state = states.get(agentId);
    if (!state) {
      state = {
        lastPromptKey: '',
        runsThisTurn: 0,
        lastRunAt: 0,
        current: null,
        difficulty: null,
        recentFiles: [],
        failures: [],
      };
      states.set(agentId, state);
    }
    return state;
  };

  // ── 观测：收集本会话碰过的文件与失败证据，喂给简报 ──────────────────
  const toolTargetOf = (args) => {
    if (!args || typeof args !== 'object') return '';
    const value = args.file_path ?? args.path ?? args.filePath ?? args.cwd ?? args.command;
    return typeof value === 'string' ? value.slice(0, 200) : '';
  };

  const failureTextOf = (result) => {
    if (!result || typeof result !== 'object') return '';
    const text = contentText(result.content);
    if (result.isError === true) {
      return String(result.error?.message ?? result.error?.reason ?? text ?? '工具报错').slice(0, 240);
    }
    const match = /\[exit code:\s*(-?\d+)\]/.exec(text);
    if (match && Number(match[1]) !== 0) return text.slice(-240);
    return '';
  };

  ctx.on('tools/result', (exec, result) => {
    try {
      const agentId = exec?.agent?.id;
      if (!agentId) return;
      const state = stateFor(agentId);
      const target = toolTargetOf(exec.arguments);
      if (target && /[\\/]/.test(target)) {
        const existing = state.recentFiles.find((item) => item.path === target);
        if (existing) {
          existing.note = exec.name ?? existing.note;
        } else {
          state.recentFiles.push({ path: target, note: exec.name ?? '' });
          if (state.recentFiles.length > 8) state.recentFiles.shift();
        }
      }
      const failure = failureTextOf(result);
      if (failure) {
        state.failures.push({ tool: exec.name ?? 'tool', target, firstLine: failure });
        if (state.failures.length > 3) state.failures.shift();
      }
    } catch {
      /* 观测失败不影响主流程 */
    }
  });

  const canRunNow = (state, now = Date.now()) => {
    if (state.runsThisTurn >= cfg.auto.maxRunsPerTurn) return { ok: false, reason: `本轮已达 ${cfg.auto.maxRunsPerTurn} 次` };
    const cooldownMs = Math.max(0, cfg.auto.cooldownMinutes) * 60_000;
    if (cooldownMs > 0 && state.lastRunAt && now - state.lastRunAt < cooldownMs) {
      return { ok: false, reason: `冷却中（${Math.ceil((cooldownMs - (now - state.lastRunAt)) / 60000)} 分钟）` };
    }
    return { ok: true };
  };

  const renderLine = (state) => renderRouteLine({ state, cfg, now: Date.now() });

  const agentCwdHint = (agent) => {
    try {
      const workingDirectory = ctx.get('workingDirectory');
      if (workingDirectory && typeof workingDirectory.get === 'function' && agent?.session) {
        return workingDirectory.get(agent.session);
      }
    } catch {
      /* 取不到就用进程目录 */
    }
    return process.cwd();
  };

  /** 带超时的等待（方案段不能被一个卡住的 CLI 拖死）。 */
  const waitForPlan = (promise, minutes, signal) => {
    let timer = null;
    let onAbort;
    const guard = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new DOMException(`方案段超时（${minutes} 分钟）`, 'TimeoutError')), minutes * 60_000);
      timer.unref();
    });
    return Promise.race([promise, guard]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  };

  /** 角色接力：方案段（静默）→ 执行段（回注）。方案段失败则退回单发。 */
  const runRelay = async (agent, state, prompt, signal) => {
    const planChannel = channels[cfg.relay.planChannel];
    const execChannel = channels[cfg.relay.executeChannel];
    const cwd = agentCwdHint(agent);
    const shared = {
      prompt,
      cwd,
      files: state.recentFiles.slice(-8),
      failures: state.failures.slice(-3),
      maxChars: cfg.brief.planChars,
      maxFiles: 8,
    };

    let planText = '';
    let planActivation = null;
    try {
      signal?.throwIfAborted();
      const planBrief = buildBrief({ ...shared, cliId: cfg.relay.planChannel, model: planChannel.model, role: 'planner' });
      planActivation = await subagents.startActivation({
        provider: planChannel.name,
        label: 'auto:relay:plan',
        prompt: [{ type: 'text', text: planBrief }],
        parent: agent,
        signal,
        delivery: 'caller',
      });
      const planResult = await waitForPlan(planActivation.result, cfg.relay.planTimeoutMinutes, signal);
      if (planResult?.stopReason === 'completed') planText = extractPlan(planResult);
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: cfg.relay.planChannel,
        action: planText ? 'relay-plan' : 'relay-plan-failed',
        chars: planText.length,
        stopReason: planResult?.stopReason ?? 'unknown',
      });
      diag(planText ? `接力方案段完成：${planText.length} 字` : '方案段未返回可用方案，退回单发');
    } catch (error) {
      if (!signal?.aborted) {
        diag(`接力方案段失败，退回单发：${error?.message ?? error}`);
        appendDecision({
          at: Date.now(),
          agent: agent.id,
          route: cfg.relay.planChannel,
          action: 'relay-plan-failed',
          stopReason: error?.name === 'TimeoutError' ? 'timeout' : 'error',
          error: String(error?.message ?? error),
        });
      }
    } finally {
      try {
        await planActivation?.dispose?.();
      } catch (error) {
        diag(`释放方案段失败：${error?.message ?? error}`);
      }
    }

    if (signal?.aborted) {
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: cfg.relay.planChannel,
        action: 'relay-aborted',
      });
      return;
    }

    const executeKey = execChannel?.enabled ? cfg.relay.executeChannel : cfg.relay.planChannel;
    const executionChannel = channels[executeKey];
    if (!execChannel?.enabled) {
      planText = '';
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: cfg.relay.executeChannel,
        action: 'relay-exec-disabled',
      });
    }

    const gate = budgetState();
    if (!gate.ok) {
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: executeKey,
        action: 'skipped',
        stage: 'relay-exec',
        reason: gate.reason,
        spent: gate.spent,
        limit: gate.limit,
      });
      return;
    }

    const execBrief = buildBrief({
      ...shared,
      cliId: executeKey,
      model: executionChannel.model,
      plan: planText,
    });
    try {
      const execActivation = await subagents.startActivation({
        provider: executionChannel.name,
        label: planText ? 'auto:relay:exec' : `auto:${executeKey}`,
        prompt: [{ type: 'text', text: execBrief }],
        parent: agent,
        signal,
        delivery: 'parent',
      });
      diag(`接力执行段 → ${execActivation?.name ?? execActivation?.childId ?? '?'}`);
      state.yielded = {
        at: Date.now(),
        provider: `${cfg.relay.planChannel} → ${cfg.relay.executeChannel}`,
        partLabel: '接力',
        targets: [],
        relay: true,
      };
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: cfg.relay.executeChannel,
        action: 'yield',
        relay: { plan: cfg.relay.planChannel, execute: cfg.relay.executeChannel },
      });
    } catch (error) {
      diag(`接力执行段失败：${error?.message ?? error}`);
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: executeKey,
        action: 'relay-exec-failed',
        error: String(error?.message ?? error),
      });
    }
  };

  const dispatch = async (agent, state, prompt, decision, signal, turnSignal) => {
    const channel = channels[decision.route];
    if (!channel || !channel.enabled) {
      appendDecision({ at: Date.now(), agent: agent.id, route: decision.route, action: 'skipped', reason: '通道未启用' });
      return;
    }
    const cwd = agentCwdHint(agent);

    // 预算闸门：超额就不派，记一条 skipped
    const budgetGate = budgetState();
    if (!budgetGate.ok) {
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: decision.route,
        action: 'skipped',
        reason: budgetGate.reason,
        spent: budgetGate.spent,
        limit: budgetGate.limit,
      });
      return;
    }

    // 角色接力：难度够 + 路由是方案方 → 两段串行（方案静默，执行回注）
    const relayInput = { relay: cfg.relay, route: decision.route, level: state.difficulty?.level };
    const execEnabled = channels[cfg.relay.executeChannel]?.enabled === true;
    if (shouldRelay({ ...relayInput, execEnabled })) {
      state.runsThisTurn += 1;
      state.lastRunAt = Date.now();
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: decision.route,
        action: 'dispatch',
        relay: { plan: cfg.relay.planChannel, execute: cfg.relay.executeChannel },
        difficulty: state.difficulty,
        reason: decision.reason,
        promptChars: prompt.length,
        promptPreview: preview(prompt, 120),
      });
      return runRelay(agent, state, prompt, turnSignal ? AbortSignal.any([signal, turnSignal]) : signal);
    }

    const relayExecDisabled = !execEnabled && shouldRelay(relayInput);
    if (relayExecDisabled) {
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: cfg.relay.executeChannel,
        action: 'relay-exec-disabled',
      });
    }

    // 并行扇出：只有 team.enabled 且提示里出现 ≥2 个目标时才拆
    const fanout = cfg.team.enabled && !relayExecDisabled
      ? splitTargets(prompt, { maxParts: cfg.team.maxParallel, minTargets: cfg.team.minTargets })
      : null;
    const parts = fanout ? fanout.parts : [{ index: 1, total: 1, targets: [] }];

    state.runsThisTurn += 1;
    state.lastRunAt = Date.now();
    appendDecision({
      at: Date.now(),
      agent: agent.id,
      route: decision.route,
      action: 'dispatch',
      provider: channel.name,
      cwd,
      promptChars: prompt.length,
      promptPreview: preview(prompt, 120),
      difficulty: state.difficulty,
      reason: decision.reason,
      fanout: fanout ? { total: parts.length, targets: fanout.targets } : null,
    });

    const started = [];
    // 接上回合信号：用户点「停止」时要能真正终止，而不只终止插件自己的 controller
    const abortSignal = turnSignal ? AbortSignal.any([signal, turnSignal]) : signal;
    for (const part of parts) {
      const brief = buildBrief({
        prompt,
        cwd,
        cliId: decision.route,
        model: channel.model,
        files: state.recentFiles.slice(-8),
        failures: state.failures.slice(-3),
        targets: part.targets,
        part: fanout ? part : null,
        maxChars: cfg.brief.maxChars,
        maxFiles: 8,
      });
      const label = fanout ? `auto:${decision.route}:${part.index}/${part.total}` : `auto:${decision.route}`;

      try {
        const activation = await subagents.startActivation({
          provider: channel.name,
          label,
          prompt: [{ type: 'text', text: brief }],
          parent: agent,
          signal: abortSignal,
          delivery: 'parent',
        });
        diag(`兜底派发 ${channel.name}${fanout ? ` [${part.index}/${part.total}]` : ''} → ${activation?.name ?? activation?.childId ?? '?'}`);
        started.push(part.index);
      } catch (error) {
        diag(`兜底派发失败：${error?.message ?? error}`);
        appendDecision({
          at: Date.now(),
          agent: agent.id,
          route: decision.route,
          action: 'failed',
          part: part.index,
          error: String(error?.message ?? error),
        });
      }
    }

    // 至少一份真发出去了 → 让出（除非全部失败）
    if (started.length > 0) {
      state.yielded = {
        at: Date.now(),
        provider: channel.name,
        partLabel: fanout ? `${started.length}/${parts.length} 份并行` : '单发',
        targets: fanout ? fanout.targets : [],
        relay: false,
      };
      appendDecision({
        at: Date.now(),
        agent: agent.id,
        route: decision.route,
        action: 'yield',
        provider: channel.name,
        parts: started.length,
      });
    }
  };

  const setupAgent = (agent) => {
    const state = stateFor(agent.id);
    const agentCtx = agent.ctx;
    if (!agentCtx) return;
    const disposers = [];
    const tryRegister = (label, register) => {
      try {
        const dispose = register();
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        diag(`注册 ${label} 失败：${error?.message ?? error}`);
      }
    };

    if (cfg.auto.enabled) {
      tryRegister('agent/pre-step', () =>
        agentCtx.on('agent/pre-step', async (payload, next) => {
          try {
            const session = payload?.agent?.session ?? agent.session;
            const prompt = textOf(payload?.messages) || lastUserTextFromSession(session);
            const key = `${payload?.turn ?? 0}:${hashText(prompt)}`;
            if (!prompt || state.lastPromptKey === key) return next();
            state.lastPromptKey = key;
            state.runsThisTurn = 0;
            state.yielded = null; // 新一轮开始，让出状态作废

            // 官方完成通知不是新任务，别二次判定
            const trimmed = prompt.trimStart();
            if (NOTICE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return next();
            if (prompt.length < cfg.auto.minPromptChars) return next();

            const cwd = agentCwdHint(agent);
            const fileCount = countPaths(prompt);
            const rule = decideByRules(cfg.auto.rules, { prompt, cwd, fileCount }) ?? {
              route: 'self',
              reason: '未命中规则',
            };
            const difficulty = estimateDifficulty({ prompt, cwd, fileCount });
            const gate = applyThreshold({ route: rule.route, level: difficulty.level, thresholds: cfg.auto.thresholds });
            const decision = gate.gated
              ? { route: 'self', reason: gate.reason }
              : { route: rule.route, reason: rule.reason };

            state.current = decision;
            state.difficulty = difficulty;
            appendDecision({
              at: Date.now(),
              agent: agent.id,
              route: decision.route,
              ruleRoute: rule.route,
              reason: decision.reason,
              difficulty: { level: difficulty.level, score: difficulty.score, signals: difficulty.signals },
              mode: cfg.auto.mode,
              promptChars: prompt.length,
            });

            if (cfg.auto.mode === 'dispatch' && decision.route !== 'self') {
              const gate2 = canRunNow(state);
              if (!gate2.ok) {
                appendDecision({ at: Date.now(), agent: agent.id, route: decision.route, action: 'skipped', reason: gate2.reason });
              } else {
                const controller = new AbortController();
                state.abort = controller;
                void dispatch(agent, state, prompt, decision, controller.signal, payload?.signal);
              }
            }
          } catch (error) {
            diag(`pre-step 判定失败：${error?.message ?? error}`);
          }
          return next();
        }),
      );

      const promptService = agentCtx.get?.('systemPrompt');
      if (promptService && typeof promptService.context === 'function') {
        tryRegister('systemPrompt.context', () =>
          promptService.context({
            name: `subagent-native-route-${++routeContextSeq}`,
            order: 8900,
            text: () => renderLine(state),
          }),
        );
      }
    }

    cleanups.set(agent.id, disposers);
  };

  ctx.on('agent/created', ({ agent }) => {
    try {
      setupAgent(agent);
    } catch (error) {
      diag(`会话初始化失败：${error?.message ?? error}`);
    }
  });

  ctx.inject(['agents'], (agentSvcCtx) => {
    const agents = agentSvcCtx.agents;
    if (!agents || typeof agents.list !== 'function') return;
    for (const agent of agents.list()) {
      if (cleanups.has(agent.id)) continue;
      try {
        setupAgent(agent);
      } catch (error) {
        diag(`既有会话接线失败：${error?.message ?? error}`);
      }
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const disposers = cleanups.get(agent.id) ?? [];
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 已释放 */
      }
    }
    cleanups.delete(agent.id);
    states.get(agent.id)?.abort?.abort?.();
    states.delete(agent.id);
  });

  ctx.effect(() => () => {
    for (const disposers of cleanups.values()) {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 已释放 */
        }
      }
    }
    cleanups.clear();
    states.clear();
  });

  // ── 历史接口 ────────────────────────────────────────────────────────
  const jsonResponse = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    if (!webServer || typeof webServer.register !== 'function') return;
    const disposers = [];

    /** 写接口的来源校验：同源 + JSON 请求体，防跨站改写配置。 */
    const writeGuard = (req) => {
      const origin = req.headers?.origin;
      if (origin) {
        let expected = '';
        try {
          expected = webServer.getOrigin?.() ?? '';
        } catch {
          expected = '';
        }
        if (!expected || origin !== expected) return `跨站请求被拒绝（origin=${origin}）`;
      }
      const type = String(req.headers?.['content-type'] ?? '').toLowerCase();
      if (!type.includes('application/json')) return '写接口只接受 content-type: application/json';
      return null;
    };
    try {
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: '/api/subagent-native/history',
          resource: async () =>
            jsonResponse({
              summary: summarize(runs),
              runs: runs.slice(-50).reverse(),
              decisions: decisions.slice(-50).reverse(),
              budget: budgetState(),
              config: configSnapshot(),
              files: { runs: runsFile, decisions: decisionsFile },
              auto: { enabled: cfg.auto.enabled, mode: cfg.auto.mode, thresholds: cfg.auto.thresholds },
              team: { enabled: cfg.team.enabled, maxParallel: cfg.team.maxParallel, minTargets: cfg.team.minTargets },
            }),
        }),
      );
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: '/api/subagent-native/config',
          handler: async (req, res) => {
            const send = (status, value) => {
              res.statusCode = status;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.setHeader('cache-control', 'no-store');
              res.end(JSON.stringify(value));
            };
            if (req.method === 'GET') return send(200, configSnapshot());
            if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
            const guardError = writeGuard(req);
            if (guardError) return send(403, { error: guardError });
            let body;
            try {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              body = raw ? JSON.parse(raw) : {};
            } catch {
              return send(400, { error: '请求体不是合法 JSON' });
            }
            try {
              const applied = await applyConfigPatch(body ?? {});
              diag(`config saved via ui: ${JSON.stringify(applied)}`);
              return send(200, { ok: true, applied });
            } catch (error) {
              diag(`config save failed: ${error?.message ?? error}`);
              return send(400, { error: String(error?.message ?? error) });
            }
          },
        }),
      );
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: '/api/subagent-native/history/clear',
          handler: async (req, res) => {
            const send = (status, value) => {
              res.statusCode = status;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(value));
            };
            if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
            const guardError = writeGuard(req);
            if (guardError) return send(403, { error: guardError });
            runs = [];
            decisions = [];
            store.clear();
            decisionLog.clear();
            // 预算账本故意不清：清历史不能让今日预算复位
            return send(200, { ok: true, ledgerKept: true, spentToday: ledger.today() });
          },
        }),
      );
      diag('history routes registered');
    } catch (error) {
      diag(`history routes failed：${error?.message ?? error}`);
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 已释放 */
        }
      }
    };
  });
}
