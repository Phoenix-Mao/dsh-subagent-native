import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureBaseline, diffSince } from '../lib/git-snapshot.js';

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 把 node 的 child_process.spawn 适配成 subprocess.spawn 的句柄形状。 */
function adapter() {
  return (spec) => {
    const [command, ...args] = spec.argv;
    const child = nodeSpawn(command, args, { cwd: spec.cwd, stdio: 'pipe' });
    const done = new Promise((resolve) => {
      child.on('exit', (code) => resolve({ exitCode: code ?? 0, signal: null }));
      child.on('error', () => resolve({ exitCode: 1, signal: null }));
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      done,
      terminate: () => child.kill(),
      async waitForExit() {
        return true;
      },
    };
  };
}

function makeRepo({ withNested = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sne-real-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'root.txt'), 'root\n', 'utf8');
  if (withNested) {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'one\n', 'utf8');
  }
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  return { dir, nested: path.join(dir, 'sub') };
}

test('真实 git：抓到 cwd 范围内的修改与新增', { skip: !hasGit() }, async () => {
  const { dir, nested } = makeRepo({ withNested: true });
  const spawn = adapter();
  const baseline = await captureBaseline({ spawn, cwd: nested });
  assert.ok(baseline, '应能取到基线');
  assert.equal(baseline.rel, 'sub', '范围应限定到子目录');

  fs.writeFileSync(path.join(nested, 'a.txt'), 'one\ntwo\n', 'utf8');
  fs.writeFileSync(path.join(nested, 'b.txt'), 'new\n', 'utf8');

  const diff = await diffSince({ spawn, cwd: nested, baseline });
  // git status 输出的是相对仓库根的路径（sub/...），对用户来说无歧义
  assert.ok(diff.changedFiles.includes('sub/a.txt'), `修改未捕获：${JSON.stringify(diff.changedFiles)}`);
  assert.ok(diff.untrackedAdded.includes('sub/b.txt'), `新增未捕获：${JSON.stringify(diff.untrackedAdded)}`);
  assert.ok(!diff.changedFiles.some((file) => file.includes('root.txt')), '不应包含范围外文件');
});

test('真实 git：cwd 范围外的改动不算进本次运行', { skip: !hasGit() }, async () => {
  const { dir, nested } = makeRepo({ withNested: true });
  const spawn = adapter();
  const baseline = await captureBaseline({ spawn, cwd: nested });

  // 在仓库根（cwd 之外）改文件
  fs.writeFileSync(path.join(dir, 'root.txt'), 'root changed\n', 'utf8');

  const diff = await diffSince({ spawn, cwd: nested, baseline });
  assert.deepEqual(diff.changedFiles, [], `范围外改动被误报：${JSON.stringify(diff.changedFiles)}`);
  assert.deepEqual(diff.untrackedAdded, []);
});

test('真实 git：没有改动时两者都为空', { skip: !hasGit() }, async () => {
  const { nested } = makeRepo({ withNested: true });
  const spawn = adapter();
  const baseline = await captureBaseline({ spawn, cwd: nested });
  const diff = await diffSince({ spawn, cwd: nested, baseline });
  assert.deepEqual(diff.changedFiles, []);
  assert.deepEqual(diff.untrackedAdded, []);
});
