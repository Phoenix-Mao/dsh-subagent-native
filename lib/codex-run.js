/**
 * 原生 Codex 一次性执行：拉起本机 codex CLI（不是 DSH 自带的 0.153.4 包装）。
 *
 * 为什么不用官方 provider：它用包内固定的 app-server，初始化时自称 deepseek-harness，
 * 中转站认不出是 Codex，按标准 API 价收费（2026-11-24 账单反推证实）。原生 CLI 用自己的
 * 配置与身份，才能吃到 Codex 渠道价。
 *
 * 铁律（沿用 auto-delegate 的实测教训）：
 *   - 完成判定只看 `turn.completed` 事件，**不等 exit code、不等 close**；
 *   - 收到完成信号后主动 terminate 整个进程树（原生 codex 干完活可能长时间不退出）。
 */

const COMPLETION = 'turn.completed';
const FAILURE_TYPES = new Set(['turn.failed', 'error', 'stream.error']);

export function buildCodexArgs({ cwd, model, effort, sandbox, extraArgs = [], readOnly = false }) {
  if (!cwd) throw new Error('native-codex: 缺少 cwd');
  const args = ['exec', '--json'];
  // 只有只读运行才跳过 git 检查：可写运行留在仓库里，改坏了还能回滚
  if (readOnly) args.push('--skip-git-repo-check');
  args.push('-C', String(cwd), '--color', 'never');
  if (model) args.push('-m', String(model));
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (readOnly) {
    args.push('-s', 'read-only', '-c', 'approval_policy="never"');
  } else {
    if (sandbox) args.push('-s', String(sandbox));
    args.push(...extraArgs);
  }
  args.push('-'); // 提示词走 stdin
  return args;
}

/**
 * @param {{
 *   spawn: (spec: object) => any,
 *   command: string,
 *   args: string[],
 *   cwd: string,
 *   prompt: string,
 *   timeoutMinutes?: number,
 *   graceMs?: number,
 *   signal?: AbortSignal,
 *   onCancel?: (cancel: () => void) => void,
 * }} options
 */
export function runCodexOnce(options) {
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
    /** 已经决定收尾（完成/取消/超时）：此时进程退出不再算作 error。 */
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
          // 正在完成/取消的收尾流程优先；只有「自然退出且没等到事件」才算 error。
          // 给 readline 一个排空窗口：进程可能在最后一行还没被读完时就退出。
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

    const onAbort = () => {
      problems.push('调用方取消');
      void terminate('aborted');
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // 把「主动取消」交给上层（provider 的 dispose 用）
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

    // 逐行解析 JSONL
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
        if (FAILURE_TYPES.has(event.type)) {
          problems.push(`codex 报错事件：${trimmed.slice(0, 300)}`);
          // 失败事件之后进程可能继续存活并持续输出，必须主动收尾，不能等空闲超时
          finishing = true;
          setTimeout(() => void terminate('error'), 300);
          return;
        }
        if (event.type === COMPLETION) {
          // 立刻标记收尾（进程可能在这 300ms 内退出，不能算 error），
          // 再等 300ms 让缓冲行刷完，然后主动终止。
          finishing = true;
          setTimeout(() => void terminate('completed'), 300);
        }
      });
      rl.on('error', (error) => problems.push(`读取事件流失败：${error?.message ?? error}`));
      armIdle();
    });
  });
}

function extractAnswer(events) {
  const parts = [];
  for (const event of events) {
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      parts.push(event.item.text);
    }
  }
  return parts.join('\n');
}

function extractUsage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.usage;
    if (!usage || typeof usage !== 'object') continue;
    return {
      input: num(usage.input_tokens),
      cached: num(usage.cached_input_tokens),
      output: num(usage.output_tokens),
      reasoning: num(usage.reasoning_output_tokens),
    };
  }
  return null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
