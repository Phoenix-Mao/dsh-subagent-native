import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { buildCodexArgs, runCodexOnce } from '../lib/codex-run.js';

function fakeHandle({ lines = [], exitCode = 0, endStream = true, keepAlive = false }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state = { terminated: false };
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  setTimeout(() => {
    for (const line of lines) stdout.write(`${line}\n`);
    if (endStream) stdout.end();
    if (!state.terminated && !keepAlive) resolveDone({ exitCode, signal: null });
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

test('buildCodexArgs：模型与强度按 codex 的 argv 拼', () => {
  assert.deepEqual(buildCodexArgs({ cwd: 'C:\\work', model: 'gpt-6.2-sol', effort: 'high' }), [
    'exec',
    '--json',
    '-C',
    'C:\\work',
    '--color',
    'never',
    '-m',
    'gpt-6.2-sol',
    '-c',
    'model_reasoning_effort=high',
    '-',
  ]);
  // 不传 model/effort 时不带对应参数
  assert.deepEqual(buildCodexArgs({ cwd: 'C:\\work' }).filter((item) => item === '-m' || item === '-c'), []);
  assert.throws(() => buildCodexArgs({}), /缺少 cwd/);
});

test('buildCodexArgs：只有只读运行才跳过 git 检查', () => {
  const writable = buildCodexArgs({ cwd: 'C:\\repo', sandbox: 'workspace-write' });
  assert.equal(writable.includes('--skip-git-repo-check'), false, '可写运行应留在 git 仓库里');
  const readonly = buildCodexArgs({ cwd: 'C:\\repo', readOnly: true });
  assert.ok(readonly.includes('--skip-git-repo-check'));
});

test('buildCodexArgs：方案段固定只读沙箱且忽略额外参数', () => {
  const args = buildCodexArgs({
    cwd: 'C:\\work',
    sandbox: 'workspace-write',
    extraArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    readOnly: true,
  });
  assert.deepEqual(args.slice(-5), ['-s', 'read-only', '-c', 'approval_policy="never"', '-']);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('runCodexOnce：见到 turn.completed 即判完成并主动 terminate', async () => {
  const { handle, state } = fakeHandle({
    lines: [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '可用' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 2 } }),
    ],
    endStream: false,
  });

  const value = await runCodexOnce({
    spawn: () => handle,
    command: 'codex',
    args: ['exec'],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });

  assert.equal(value.stopReason, 'completed');
  assert.equal(value.answer, '可用');
  assert.deepEqual(value.usage, { input: 100, cached: 40, output: 2, reasoning: 0 });
  assert.equal(state.terminated, true, '完成事件后要主动 terminate，不等自然退出');
});

test('runCodexOnce：turn.failed → error 且带诊断', async () => {
  const { handle } = fakeHandle({
    lines: [JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })],
  });
  const value = await runCodexOnce({
    spawn: () => handle,
    command: 'codex',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });
  assert.equal(value.stopReason, 'error');
  assert.ok(value.problems.some((item) => item.includes('turn.failed')));
});

test('runCodexOnce：进程退出但没完成事件 → error', async () => {
  const { handle } = fakeHandle({ lines: [JSON.stringify({ type: 'thread.started' })], exitCode: 1 });
  const value = await runCodexOnce({
    spawn: () => handle,
    command: 'codex',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });
  assert.equal(value.stopReason, 'error');
});

test('runCodexOnce：调用方取消 → aborted', async () => {
  const controller = new AbortController();
  const { handle } = fakeHandle({ lines: [], endStream: false, keepAlive: true });
  const pending = runCodexOnce({
    spawn: () => handle,
    command: 'codex',
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
});

test('runCodexOnce：spawn 抛错 → error', async () => {
  const value = await runCodexOnce({
    spawn: () => {
      throw new Error('no codex');
    },
    command: 'codex',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
  });
  assert.equal(value.stopReason, 'error');
  assert.ok(value.problems.some((item) => item.includes('spawn 失败')));
});

test('runCodexOnce：dispose 用的 cancel 回调能终止运行', async () => {
  let cancel = null;
  const { handle, state } = fakeHandle({ lines: [], endStream: false, keepAlive: true });
  const pending = runCodexOnce({
    spawn: () => handle,
    command: 'codex',
    args: [],
    cwd: 'C:\\work',
    prompt: 'x',
    graceMs: 200,
    timeoutMinutes: 1,
    onCancel: (fn) => {
      cancel = fn;
    },
  });
  setTimeout(() => cancel?.(), 10);
  const value = await pending;
  assert.equal(value.stopReason, 'aborted');
  assert.equal(state.terminated, true);
});
