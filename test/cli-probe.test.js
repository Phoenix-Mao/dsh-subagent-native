import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findExecutable, missingCliMessage, summarizeCli } from '../lib/cli-probe.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sne-cli-'));
}

test('findExecutable：空命令直接判未找到', () => {
  const result = findExecutable('');
  assert.equal(result.found, false);
  assert.equal(result.reason, '命令为空');
});

test('findExecutable：Windows 上按 .exe/.cmd/.bat 找', () => {
  const dir = tempDir();
  const file = path.join(dir, 'fake-codex.cmd');
  fs.writeFileSync(file, '@echo off\n', 'utf8');
  const result = findExecutable('fake-codex', { platform: 'win32', env: { Path: dir } });
  assert.equal(result.found, true);
  assert.equal(result.path, file);
});

test('findExecutable：PATH 为空时原因说得清', () => {
  const result = findExecutable('codex', { platform: 'win32', env: {} });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'PATH 为空');
});

test('findExecutable：带分隔符当路径处理，不再遍历 PATH', () => {
  const dir = tempDir();
  const missing = path.join(dir, 'nope.exe');
  const result = findExecutable(missing, { platform: 'win32', env: { PATH: dir } });
  assert.equal(result.found, false);
  assert.equal(result.searched, 1);
  assert.equal(result.reason, '指定的路径不存在或不可执行');
});

test('findExecutable：目录不算可执行文件', () => {
  const dir = tempDir();
  const lookalike = path.join(dir, 'fake-dir');
  fs.mkdirSync(lookalike);
  const result = findExecutable('fake-dir', { platform: 'win32', env: { PATH: dir } });
  assert.equal(result.found, false);
});

test('findExecutable：非 Windows 不带后缀', () => {
  const dir = tempDir();
  const bare = path.join(dir, 'fake-claude');
  fs.writeFileSync(bare, '#!/bin/sh\n', 'utf8');
  // Windows 宿主上 X_OK 等同于存在性检查，这里只在 POSIX 上补可执行位
  if (process.platform !== 'win32') fs.chmodSync(bare, 0o755);

  const found = findExecutable('fake-claude', { platform: 'linux', env: { PATH: dir } });
  assert.equal(found.found, true);
  assert.equal(found.path, bare);
});

test(
  'findExecutable：非 Windows 上不可执行的普通文件不算 CLI',
  { skip: process.platform === 'win32' ? 'Windows 宿主上 X_OK 不区分权限位，只能在 POSIX 验证' : false },
  () => {
    const dir = tempDir();
    const plain = path.join(dir, 'plain-file');
    fs.writeFileSync(plain, 'data\n', 'utf8');
    fs.chmodSync(plain, 0o644);
    assert.equal(findExecutable('plain-file', { platform: 'linux', env: { PATH: dir } }).found, false);
  },
);

test('summarizeCli：未找到时给出 command 与 reason', () => {
  const summary = summarizeCli('missing-cli-xyz', { platform: 'win32', env: { PATH: tempDir() } });
  assert.deepEqual(summary, {
    command: 'missing-cli-xyz',
    found: false,
    path: null,
    reason: 'PATH 里没有找到',
  });
});

test('missingCliMessage：说清装法，且不拼进本机路径', () => {
  const codex = missingCliMessage({ channel: 'codex', command: 'codex', reason: 'PATH 里没有找到' });
  assert.ok(codex.includes('npm install -g @openai/codex'), '应给出 codex 安装命令');
  assert.ok(codex.includes('codex --version'), '应告诉用户怎么自检');
  assert.ok(codex.includes('设置页'), '应告诉用户还有第二条路');

  const claude = missingCliMessage({ channel: 'claude', command: 'claude', reason: 'PATH 为空' });
  assert.ok(claude.includes('npm install -g @anthropic-ai/claude-code'));

  // 文案只带命令名与原因，不含任何盘符/绝对路径
  assert.equal(/[A-Za-z]:\\/.test(codex), false);
  assert.equal(/\/(usr|home|tmp)\//.test(codex), false);
});
