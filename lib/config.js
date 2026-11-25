/**
 * 配置层：解析、默认值、设置页写回的白名单校验。
 *
 * 从 index.js 抽出来的目的：这些是纯函数，能单测；index.js 只留编排。
 */
import { DEFAULT_RULES, validateRules } from './rules.js';
import { DEFAULT_PRICING, mergePricing } from './history.js';

export const LEVELS = Object.freeze(['low', 'medium', 'high', 'extreme']);
/** 插件包名：发布时只改这一处（以及 package.json / cordis.patch.yml）。 */
export const PACKAGE_NAME = '@local/dsh-subagent-native';
export const MAX_PLAN_TIMEOUT_MINUTES = 120;
export const CLAUDE_PERMISSION_MODES = Object.freeze(['plan', 'default', 'acceptEdits', 'bypassPermissions']);
export const CODEX_EFFORTS = Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const CLAUDE_EFFORTS = Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_SANDBOXES = Object.freeze(['', 'read-only', 'workspace-write', 'danger-full-access']);
export const CHANNEL_KEYS = Object.freeze(['codex', 'claude']);

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
const asObject = (value) => (value && typeof value === 'object' ? value : {});

export function resolveConfig(raw) {
  const input = asObject(raw);
  const codex = asObject(input.codex);
  const claude = asObject(input.claude);
  const auto = asObject(input.auto);
  const team = asObject(input.team);
  const budget = asObject(input.budget);
  const briefInput = asObject(input.brief);
  const relayInput = asObject(input.relay);
  const planTimeoutMinutes = Number(relayInput.planTimeoutMinutes);
  const history = asObject(input.history);
  const pricing = asObject(input.pricing);

  const thresholds = {
    claude: LEVELS.includes(auto.thresholds?.claude) ? auto.thresholds.claude : 'high',
    codex: LEVELS.includes(auto.thresholds?.codex) ? auto.thresholds.codex : 'medium',
  };
  const rules = Array.isArray(auto.rules) && auto.rules.length > 0 ? auto.rules : DEFAULT_RULES;
  validateRules(rules);

  return {
    enabled: input.enabled !== false,
    codex: {
      enabled: codex.enabled !== false,
      providerName: str(codex.providerName) || 'native-codex',
      command: str(codex.command),
      model: str(codex.model),
      effort: str(codex.effort),
      sandbox: str(codex.sandbox) || 'read-only',
      extraArgs: Array.isArray(codex.extraArgs) ? codex.extraArgs.filter((item) => typeof item === 'string') : [],
      timeoutMinutes: positive(codex.timeoutMinutes, 20),
      graceMs: positive(codex.graceMs, 10_000),
    },
    claude: {
      enabled: claude.enabled !== false,
      providerName: str(claude.providerName) || 'native-claude',
      command: str(claude.command),
      model: str(claude.model),
      effort: str(claude.effort),
      permissionMode: CLAUDE_PERMISSION_MODES.includes(claude.permissionMode) ? claude.permissionMode : 'plan',
      extraArgs: Array.isArray(claude.extraArgs) ? claude.extraArgs.filter((item) => typeof item === 'string') : [],
      timeoutMinutes: positive(claude.timeoutMinutes, 20),
      graceMs: positive(claude.graceMs, 10_000),
    },
    auto: {
      enabled: auto.enabled === true,
      mode: auto.mode === 'dispatch' ? 'dispatch' : 'observe',
      rules,
      thresholds,
      minPromptChars: positive(auto.minPromptChars, 10),
      maxRunsPerTurn: positive(auto.maxRunsPerTurn, 1),
      cooldownMinutes: Number(auto.cooldownMinutes) >= 0 ? Number(auto.cooldownMinutes) : 10,
      // 派发后是否告诉主代理「别自己再做」——这是「派出去=省钱」成立的前提
      yield: auto.yield !== false,
      yieldMinutes: positive(auto.yieldMinutes, 20),
    },
    team: {
      // 并行扇出：提示里出现 ≥2 个目标时拆成 N 份并行跑；1 = 不扇出
      enabled: team.enabled === true,
      maxParallel: Math.min(6, positive(team.maxParallel, 3)),
      minTargets: Math.max(2, positive(team.minTargets, 2)),
    },
    budget: {
      // 日上限（估算成本）；0 = 不限制。默认给一个上限：没有刹车比刹车太紧更危险
      enabled: budget.enabled !== false,
      dailyUsd: Number(budget.dailyUsd) >= 0 ? Number(budget.dailyUsd) : 2,
    },
    brief: {
      // 简报长度预算（字符）；方案段比执行段短，避免挤掉边界与验收
      maxChars: positive(briefInput.maxChars, 8000),
      planChars: positive(briefInput.planChars, 6000),
    },
    tools: {
      // 是否把通道注册成 provider —— 决定了模型能不能看到并调用子代理工具
      enabled: asObject(input.tools).enabled === true,
    },
    relay: {
      // 角色接力：方案方先出方案，执行方照做
      enabled: relayInput.enabled === true,
      planChannel: CHANNEL_KEYS.includes(relayInput.planChannel) ? relayInput.planChannel : 'claude',
      executeChannel: CHANNEL_KEYS.includes(relayInput.executeChannel) ? relayInput.executeChannel : 'codex',
      minDifficulty: LEVELS.includes(relayInput.minDifficulty) ? relayInput.minDifficulty : 'high',
      planTimeoutMinutes: planTimeoutMinutes > 0 && planTimeoutMinutes <= MAX_PLAN_TIMEOUT_MINUTES ? planTimeoutMinutes : 10,
    },
    history: {
      enabled: history.enabled !== false,
      limit: positive(history.limit, 1000),
      dir: str(history.dir),
    },
    /**
     * 成本估算价目（每百万 token）。内置值是**某个中转站**的渠道价，
     * 换站必须覆盖，否则估算与预算护栏都不可信。
     * 覆盖方式：cordis.patch.yml 里 config.pricing.codex.{input,output,cacheWrite,cacheRead}。
     */
    pricing: {
      codex: mergePricing(DEFAULT_PRICING['codex-1zhe'], pricing.codex),
      claude: mergePricing(DEFAULT_PRICING['claude-4zhe'], pricing.claude),
    },
  };
}

/**
 * 设置页写回的白名单校验：返回可直接 merge 进 loader 配置的片段。
 * 任何越界取值都抛错（设置页会把错误原文显示出来）。
 */
export function normalizePatch(patch) {
  const next = {};
  const pickLevel = (value, label) => {
    if (!LEVELS.includes(value)) throw new Error(`${label} 只能是 ${LEVELS.join(' / ')}`);
    return value;
  };
  const pick = (value, allowed, label) => {
    if (!allowed.includes(value)) throw new Error(`${label} 取值非法（可选：${allowed.filter(Boolean).join(' / ') || '空'}）`);
    return value;
  };

  if (patch?.auto) {
    next.auto = {};
    if (patch.auto.enabled != null) next.auto.enabled = Boolean(patch.auto.enabled);
    if (patch.auto.mode != null) {
      if (!['observe', 'dispatch'].includes(patch.auto.mode)) throw new Error('mode 只能是 observe / dispatch');
      next.auto.mode = patch.auto.mode;
    }
    if (patch.auto.minPromptChars != null) {
      const value = Number(patch.auto.minPromptChars);
      if (!Number.isFinite(value) || value < 0) throw new Error('minPromptChars 必须是非负数');
      next.auto.minPromptChars = value;
    }
    if (patch.auto.yield != null) next.auto.yield = Boolean(patch.auto.yield);
    if (patch.auto.yieldMinutes != null) {
      const value = Number(patch.auto.yieldMinutes);
      if (!Number.isFinite(value) || value < 1) throw new Error('yieldMinutes 必须 ≥ 1');
      next.auto.yieldMinutes = Math.round(value);
    }
    if (patch.auto.thresholds) {
      next.auto.thresholds = {};
      for (const key of CHANNEL_KEYS) {
        const value = patch.auto.thresholds[key];
        if (value == null) continue;
        next.auto.thresholds[key] = pickLevel(value, `thresholds.${key}`);
      }
    }
  }

  if (patch?.team) {
    next.team = {};
    if (patch.team.enabled != null) next.team.enabled = Boolean(patch.team.enabled);
    if (patch.team.maxParallel != null) {
      const value = Number(patch.team.maxParallel);
      if (!Number.isFinite(value) || value < 1 || value > 6) throw new Error('maxParallel 必须在 1–6（1 = 不扇出）');
      next.team.maxParallel = Math.round(value);
    }
  }

  if (patch?.budget) {
    next.budget = {};
    if (patch.budget.enabled != null) next.budget.enabled = Boolean(patch.budget.enabled);
    if (patch.budget.dailyUsd != null) {
      const value = Number(patch.budget.dailyUsd);
      if (!Number.isFinite(value) || value < 0) throw new Error('dailyUsd 必须是非负数');
      next.budget.dailyUsd = value;
    }
  }

  if (patch?.relay) {
    next.relay = {};
    if (patch.relay.enabled != null) next.relay.enabled = Boolean(patch.relay.enabled);
    if (patch.relay.minDifficulty != null) next.relay.minDifficulty = pickLevel(patch.relay.minDifficulty, 'relay.minDifficulty');
    if (patch.relay.planTimeoutMinutes != null) {
      const value = Number(patch.relay.planTimeoutMinutes);
      if (!(value > 0 && value <= MAX_PLAN_TIMEOUT_MINUTES)) {
        throw new Error(`relay.planTimeoutMinutes 必须大于 0 且不超过 ${MAX_PLAN_TIMEOUT_MINUTES}`);
      }
      next.relay.planTimeoutMinutes = value;
    }
    for (const key of ['planChannel', 'executeChannel']) {
      const value = patch.relay[key];
      if (value == null) continue;
      next.relay[key] = pick(value, CHANNEL_KEYS, key);
    }
  }

  if (patch?.brief) {
    next.brief = {};
    for (const key of ['maxChars', 'planChars']) {
      const value = patch.brief[key];
      if (value == null) continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 500) throw new Error(`brief.${key} 必须 ≥ 500`);
      next.brief[key] = Math.round(number);
    }
  }

  if (patch?.tools) {
    next.tools = {};
    if (patch.tools.enabled != null) next.tools.enabled = Boolean(patch.tools.enabled);
  }

  if (patch?.codex) {
    next.codex = {};
    if (patch.codex.model != null) next.codex.model = str(patch.codex.model);
    if (patch.codex.effort != null) next.codex.effort = pick(patch.codex.effort, CODEX_EFFORTS, 'codex effort');
    if (patch.codex.sandbox != null) next.codex.sandbox = pick(patch.codex.sandbox, CODEX_SANDBOXES, 'codex sandbox');
  }

  if (patch?.claude) {
    next.claude = {};
    if (patch.claude.model != null) next.claude.model = str(patch.claude.model);
    if (patch.claude.effort != null) next.claude.effort = pick(patch.claude.effort, CLAUDE_EFFORTS, 'claude effort');
    if (patch.claude.permissionMode != null) {
      next.claude.permissionMode = pick(patch.claude.permissionMode, CLAUDE_PERMISSION_MODES, 'permissionMode');
    }
  }

  return next;
}

/** 把校验过的片段并进现有配置（嵌套对象按段合并，thresholds 单独合并）。 */
export function mergeConfig(current = {}, inherited = {}, next = {}) {
  const merged = { ...inherited, ...current };
  for (const section of Object.keys(next)) {
    // 先记住旧的 thresholds：下一行展开时会被整体覆盖
    const previousThresholds = merged[section]?.thresholds ?? {};
    merged[section] = { ...(merged[section] ?? {}), ...next[section] };
    if (next[section]?.thresholds) {
      merged[section].thresholds = { ...previousThresholds, ...next[section].thresholds };
    }
  }
  return merged;
}
