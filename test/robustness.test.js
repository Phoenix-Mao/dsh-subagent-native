import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { buildClaudeArgs, runClaudeOnce } from '../lib/claude-run.js';
import { runCodexOnce } from '../lib/codex-run.js';

function harness({ lines = [], keepAlive = false, writeDelay = 5 }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state = { terminated: false };
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  setTimeout(() => {
    for (const line of lines) stdout.write(`${line}\n`);
    if (!keepAlive) resolveDone({ exitCode: 0, signal: null });
  }, writeDelay);
  return {
    state,
    handle: {
      stdout,
      stderr,
      done,
      terminate() {
        state.terminated = true;
        resolveDone({ exitCode: null, signal: 'SIGTERM' });
      },
      async waitForExit() {
        return true;
      },
    },
  };
}

const base = { command: 'x', args: [], cwd: 'C:\\w', prompt: 'x', graceMs: 200, timeoutMinutes: 1 };

test('codex-run：一行 null 不再崩进程，跳过并记诊断', async () => {
  const { handle } = harness({
    lines: ['null', '42', '"just a string"', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })],
    keepAlive: true,
  });
  const value = await runCodexOnce({ ...base, spawn: () => handle });
  assert.equal(value.stopReason, 'completed');
  assert.ok(value.problems.length >= 3, `应记录 3 条非事件行，实际 ${value.problems.length}`);
  assert.ok(value.problems.some((item) => item.includes('非事件行')));
});

test('claude-run：一行 null 不再崩进程，跳过并记诊断', async () => {
  const { handle } = harness({
    lines: ['null', JSON.stringify({ type: 'result', subtype: 'success', result: '可用', usage: { input_tokens: 1, output_tokens: 1 } })],
    keepAlive: true,
  });
  const value = await runClaudeOnce({ ...base, spawn: () => handle });
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.answer, '可用');
  assert.ok(value.problems.some((item) => item.includes('非事件行')));
});

test('claude-run：失败 subtype 但没有 is_error → 判失败', async () => {
  const { handle } = harness({
    lines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution', result: '出错了' })],
    keepAlive: true,
  });
  const value = await runClaudeOnce({ ...base, spawn: () => handle });
  assert.equal(value.stopReason, 'error');
  assert.ok(value.problems.some((item) => item.includes('claude 报错')));
});

test('claude-run：subtype=success 且 is_error=false → 完成', async () => {
  const { handle } = harness({
    lines: [JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '好' })],
    keepAlive: true,
  });
  const value = await runClaudeOnce({ ...base, spawn: () => handle });
  assert.equal(value.stopReason, 'completed');
});

test('codex-run：turn.failed 后进程仍存活也要收尾为 error', async () => {
  const { handle, state } = harness({
    lines: [JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })],
    keepAlive: true, // 进程不退出
  });
  const value = await runCodexOnce({ ...base, spawn: () => handle, graceMs: 100 });
  assert.equal(value.stopReason, 'error');
  assert.equal(state.terminated, true, '应当主动终止进程');
  assert.ok(value.problems.some((item) => item.includes('turn.failed')));
});

test('codex-run：进程退出抢在完成事件之前，仍判完成（排空窗口）', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  // 先让进程"退出"，再把完成事件写进 stdout
  setTimeout(() => resolveDone({ exitCode: 0, signal: null }), 5);
  setTimeout(() => {
    stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } })}\n`);
  }, 20);
  const value = await runCodexOnce({
    ...base,
    spawn: () => ({
      stdout,
      stderr,
      done,
      terminate() {},
      async waitForExit() {
        return true;
      },
    }),
    graceMs: 100,
  });
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.usage.input, 3);
});

test('claude-run：args 构造不受非只读模式影响（回归）', () => {
  const args = buildClaudeArgs({ permissionMode: 'acceptEdits' });
  assert.ok(args.includes('acceptEdits'));
  assert.ok(args.includes('--disallowedTools'));
});
