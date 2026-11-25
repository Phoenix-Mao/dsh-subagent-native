import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { checkCwd } from '../lib/guard.js';

test('checkCwd：普通项目目录放行', () => {
  assert.deepEqual(checkCwd(path.join(os.homedir(), 'projects', 'demo')), { ok: true });
});

test('checkCwd：用户主目录被拒绝', () => {
  const verdict = checkCwd(os.homedir());
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /主目录/);
});

test('checkCwd：DSH 配置目录与 profile 被拒绝', () => {
  assert.equal(checkCwd(path.join(os.homedir(), '.dsh', 'profiles', 'desktop')).ok, false);
  assert.equal(checkCwd(path.join(os.homedir(), '.dsh')).ok, false);
});

test('checkCwd：盘符根被拒绝', () => {
  const root = path.parse(process.cwd()).root;
  const verdict = checkCwd(root);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /盘符根/);
});

test('checkCwd：空路径与非绝对路径被拒绝', () => {
  assert.equal(checkCwd('').ok, false);
  assert.equal(checkCwd('relative/dir').ok, false);
});
