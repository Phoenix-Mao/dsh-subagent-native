/**
 * 原生 Claude Code 一次性执行。
 *
 * 和 codex 一样：拉起本机 claude CLI（原生配置 ~/.claude/settings.json → 中转站），
 * 只认 JSON 事件判定完成，不等 exit code。
 *
 * claude 的事件序列：system(init) → assistant(可多个) → result
 *   result.result 是最终答复，result.usage 带 token。
 */

const COMPLETION = 'result';

export const CLAUDE_READ_ONLY_MODE = 'dontAsk';

export function buildClaudeArgs({ model, effort, permissionMode = 'plan', extraArgs = [], readOnly = false } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', String(model));
  if (effort) args.push('--effort', String(effort));
  if (readOnly) {
    return [
      ...args,
      '--permission-mode', CLAUDE_READ_ONLY_MODE,
      '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'Read,Glob,Grep',
      '--strict-mcp-config',
      '--settings', '{"disableAllHooks":true}',
    ];
  }
  if (permissionMode === 'plan') args.push('--permission-mode', 'plan');
  else if (permissionMode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
  else if (permissionMode === 'default') args.push('--permission-mode', 'default');
  else if (permissionMode === 'bypassPermissions') {
    args.push('--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions');
  }
  // 非交互模式：禁掉会挂住的两个交互工具
  args.push('--disallowedTools', 'AskUserQuestion', 'ExitPlanMode');
  args.push(...extraArgs);
  return args;
}

export function runClaudeOnce(options) {
  const {
    spawn,
    command,
    args,
    cwd,
    prompt,
    timeoutMinutes = 20,
    graceMs = 10_000,
    signal,
    onCancel,
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const events = [];
    const problems = [];
    let settled = false;
    let finishing = false;
    let handle = null;
    let idleTimer = null;
    let stderrText = '';
    let exitFacts = null;
    let rl = null;

    const finish = (stopReason) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        rl?.close();
      } catch {
        /* 已关闭 */
      }
      resolve({
        stopReason,
        answer: extractAnswer(events),
        usage: extractUsage(events),
        eventCount: events.length,
        exitCode: exitFacts ? exitFacts.exitCode : null,
        stderrTail: stderrText.slice(-4000),
        problems: problems.slice(),
        durationMs: Date.now() - startedAt,
      });
    };

    const terminate = async (stopReason) => {
      finishing = true;
      try {
        handle?.terminate?.();
      } catch {
        /* 已退出 */
      }
      try {
        if (typeof handle?.waitForExit === 'function') await handle.waitForExit(AbortSignal.timeout(graceMs));
      } catch {
        problems.push('进程未在宽限期内退出');
      }
      finish(stopReason);
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const idleMs = Math.max(1, timeoutMinutes) * 60_000;
      idleTimer = setTimeout(() => {
        problems.push(`连续 ${timeoutMinutes} 分钟无输出，已终止`);
        void terminate('error');
      }, idleMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };

    try {
      handle = spawn({
        argv: [command, ...args],
        cwd,
        stdio: { stdin: { data: String(prompt ?? '') }, stdout: 'pipe', stderr: 'pipe' },
        graceMs,
      });
    } catch (error) {
      problems.push(`spawn 失败：${error?.message ?? error}`);
      finish('error');
      return;
    }
    if (!handle) {
      problems.push('spawn 返回空句柄');
      finish('error');
      return;
    }

    if (handle.stderr) {
      handle.stderr.on('data', (chunk) => {
        if (stderrText.length < 65536) stderrText += String(chunk);
      });
      handle.stderr.on('error', () => {});
    }

    if (handle.done && typeof handle.done.then === 'function') {
      handle.done.then(
        (facts) => {
          exitFacts = facts ?? null;
          // 给 readline 一个排空窗口：进程可能在最后一行还没被读完时就退出
          if (settled || finishing) return;
          const drain = setTimeout(() => {
            if (!settled && !finishing) finish('error');
          }, 200);
          if (typeof drain.unref === 'function') drain.unref();
        },
        (error) => {
          if (!settled) {
            problems.push(`进程失败：${error?.message ?? error}`);
            finish('error');
          }
        },
      );
    }

    signal?.addEventListener?.(
      'abort',
      () => {
        problems.push('调用方取消');
        void terminate('aborted');
      },
      { once: true },
    );
    onCancel?.(() => {
      if (settled || finishing) return;
      problems.push('外部取消');
      void terminate('aborted');
    });

    if (!handle.stdout) {
      problems.push('stdout 未接管');
      void terminate('error');
      return;
    }

    import('node:readline').then(({ default: readline }) => {
      rl = readline.createInterface({ input: handle.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        armIdle();
        const trimmed = String(line).trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          problems.push(`无法解析的行：${trimmed.slice(0, 160)}`);
          return;
        }
        // 合法 JSON 也可能不是对象（null / 数字 / 字符串）：直接读 event.type 会抛未捕获异常
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          problems.push(`非事件行（已跳过）：${trimmed.slice(0, 160)}`);
          return;
        }
        events.push(event);
        if (event.type === COMPLETION) {
          // 失败判定只做一次：诊断与 stopReason 必须用同一个口径
          const isFailure = event.is_error === true || (event.subtype != null && event.subtype !== 'success');
          if (isFailure) problems.push(`claude 报错：subtype=${event.subtype ?? '?'}`);
          finishing = true;
          // 先看结果再收尾：立即终止，claude 一般会自己退出，但不等它
          setTimeout(() => void terminate(isFailure ? 'error' : 'completed'), 300);
        }
      });
      rl.on('error', (error) => problems.push(`读取事件流失败：${error?.message ?? error}`));
      armIdle();
    });
  });
}

function extractAnswer(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === COMPLETION && typeof event.result === 'string') return event.result;
  }
  const parts = [];
  for (const event of events) {
    if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('');
}

function extractUsage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== COMPLETION || !event.usage || typeof event.usage !== 'object') continue;
    return {
      input: num(event.usage.input_tokens),
      cached: num(event.usage.cache_read_input_tokens),
      cacheWrite: num(event.usage.cache_creation_input_tokens),
      // 1 小时缓存写是 5 分钟的 1.6 倍价，单独记出来才能算准
      cacheWrite1h: num(event.usage.cache_creation?.ephemeral_1h_input_tokens),
      output: num(event.usage.output_tokens),
    };
  }
  return null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
