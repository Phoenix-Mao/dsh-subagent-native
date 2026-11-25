import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { buildClaudeArgs, runClaudeOnce } from '../lib/claude-run.js';

function fakeHandle({ lines = [], keepAlive = false }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state = { terminated: false };
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  setTimeout(() => {
    for (const line of lines) stdout.write(`${line}\n`);
    stdout.end();
    if (!keepAlive) resolveDone({ exitCode: 0, signal: null });
  }, 5);
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

test('buildClaudeArgs：model / effort / 权限模式 / 禁用交互工具', () => {
  assert.deepEqual(buildClaudeArgs({ model: 'claude-opus-5-5[1M]', effort: 'high', permissionMode: 'bypassPermissions' }), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'claude-opus-5-5[1M]',
    '--effort',
    'high',
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--disallowedTools',
    'AskUserQuestion',
    'ExitPlanMode',
  ]);
  assert.deepEqual(buildClaudeArgs({ permissionMode: 'plan' }).slice(-5), [
    '--permission-mode',
    'plan',
    '--disallowedTools',
    'AskUserQuestion',
    'ExitPlanMode',
  ]);
  // 不传 model/effort 时不带对应参数
  const args = buildClaudeArgs({});
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--effort'), false);
});

test('buildClaudeArgs：方案段只开放读工具且忽略额外参数', () => {
  const args = buildClaudeArgs({ readOnly: true, extraArgs: ['--tools', 'Bash'] });
  assert.deepEqual(args.slice(4), [
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'Read,Glob,Grep',
    '--strict-mcp-config',
    '--settings', '{"disableAllHooks":true}',
  ]);
});

test('runClaudeOnce：result 事件即完成，取 result 文本与 usage', async () => {
  const { handle, state } = fakeHandle({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '部分' }] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '可用',
        usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 2 },
      }),
    ],
    keepAlive: true,
  });

  const value = await runClaudeOnce({
    spawn: () => handle,
    command: 'claude',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });

  assert.equal(value.stopReason, 'completed');
  assert.equal(value.answer, '可用');
  assert.deepEqual(value.usage, { input: 10, cached: 200, cacheWrite: 30, cacheWrite1h: 0, output: 2 });
  assert.equal(state.terminated, true);
});

test('runClaudeOnce：区分 1 小时缓存写', async () => {
  const { handle } = fakeHandle({
    lines: [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 5000,
          cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 1000 },
        },
      }),
    ],
    keepAlive: true,
  });
  const value = await runClaudeOnce({
    spawn: () => handle,
    command: 'claude',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });
  assert.equal(value.usage.cacheWrite, 5000);
  assert.equal(value.usage.cacheWrite1h, 4000);
});

test('runClaudeOnce：is_error 的 result → error', async () => {
  const { handle } = fakeHandle({
    lines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })],
  });
  const value = await runClaudeOnce({
    spawn: () => handle,
    command: 'claude',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });
  assert.equal(value.stopReason, 'error');
  assert.ok(value.problems.some((item) => item.includes('claude 报错')));
});

test('runClaudeOnce：进程先退出（没 result）→ error', async () => {
  const { handle } = fakeHandle({ lines: [JSON.stringify({ type: 'system' })] });
  const value = await runClaudeOnce({
    spawn: () => handle,
    command: 'claude',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });
  assert.equal(value.stopReason, 'error');
});

test('runClaudeOnce：取消 → aborted 且 terminate', async () => {
  const controller = new AbortController();
  const { handle, state } = fakeHandle({ lines: [], keepAlive: true });
  const pending = runClaudeOnce({
    spawn: () => handle,
    command: 'claude',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const value = await pending;
  assert.equal(value.stopReason, 'aborted');
  assert.equal(state.terminated, true);
});
