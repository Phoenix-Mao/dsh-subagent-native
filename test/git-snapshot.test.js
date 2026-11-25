import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  captureBaseline,
  describeChanges,
  diffSince,
  parseStatFiles,
  parseStatus,
  runCapture,
} from '../lib/git-snapshot.js';

/** 假的 subprocess.spawn：按 argv 里的子命令返回预置输出。 */
function fakeSpawn(responses) {
  const calls = [];
  const spawn = (spec) => {
    const key = spec.argv.slice(1).join(' ');
    calls.push(key);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const match = Object.keys(responses).find((pattern) => key.startsWith(pattern));
    const body = typeof responses[match] === 'function' ? responses[match](key) : match ? responses[match] : '';
    setTimeout(() => {
      stdout.write(body ?? '');
      stdout.end();
      resolveDone({ exitCode: match ? 0 : 1, signal: null });
    }, 1);
    return {
      stdout,
      stderr,
      done,
      terminate() {
        resolveDone({ exitCode: 1, signal: 'SIGTERM' });
      },
      async waitForExit() {
        return true;
      },
    };
  };
  return { spawn, calls };
}

test('runCapture：收集 stdout 并在退出后返回', async () => {
  const { spawn } = fakeSpawn({ 'rev-parse': 'true\n' });
  const result = await runCapture(spawn, ['git', 'rev-parse', '--is-inside-work-tree'], 'C:\\w', 1000);
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'true');
});

test('runCapture：spawn 抛错时不炸，返回失败', async () => {
  const result = await runCapture(() => {
    throw new Error('no git');
  }, ['git'], 'C:\\w', 500);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /no git/);
});

test('parseStatus：识别修改/新增/重命名', () => {
  assert.deepEqual(parseStatus(' M a.cs\n?? new/b.js\nA  c.ts\nR  old.ts -> new.ts\n'), [
    { code: ' M', path: 'a.cs' },
    { code: '??', path: 'new/b.js' },
    { code: 'A ', path: 'c.ts' },
    { code: 'R ', path: 'new.ts' },
  ]);
  assert.deepEqual(parseStatus(''), []);
});

test('parseStatFiles：解析 git diff --stat', () => {
  assert.deepEqual(parseStatFiles(' src/a.cs | 12 +++---\n src/b.cs |  3 +-\n'), ['src/a.cs', 'src/b.cs']);
});

test('captureBaseline：非 git 目录返回 null', async () => {
  const { spawn } = fakeSpawn({ 'rev-parse': 'false\n' });
  assert.equal(await captureBaseline({ spawn, cwd: 'C:\\notgit' }), null);
});

test('captureBaseline：记录 toplevel、相对路径与当前 status', async () => {
  const { spawn, calls } = fakeSpawn({
    'rev-parse --is-inside-work-tree': 'true\n',
    'rev-parse --show-toplevel': 'C:/repo\n',
    'status --porcelain': '?? draft.js\n',
  });
  const baseline = await captureBaseline({ spawn, cwd: 'C:/repo/sub' });
  assert.equal(baseline.toplevel, 'C:/repo');
  assert.equal(baseline.rel, 'sub');
  assert.deepEqual(baseline.status, [{ code: '??', path: 'draft.js' }]);
  // 必须把范围限定到 cwd（pathspec 相对 cwd，用 '.'），否则会把整个仓库的改动都算进来
  assert.ok(calls.some((call) => call.startsWith('status --porcelain') && call.endsWith('-- .')));
  assert.ok(!calls.some((call) => call.startsWith('stash')), '不应使用昂贵的 stash create');
});

test('diffSince：用前后差集判断归属，剔除基线里已有的改动', async () => {
  const { spawn } = fakeSpawn({
    'status --porcelain': ' M old.js\n M changed.js\n?? added.js\n',
    'diff --stat': ' changed.js | 4 ++--\n',
  });
  const baseline = { toplevel: 'C:/repo', rel: '', status: [{ code: ' M', path: 'old.js' }] };
  const diff = await diffSince({ spawn, cwd: 'C:/repo', baseline });
  assert.deepEqual(diff.changedFiles, ['changed.js']);
  assert.deepEqual(diff.untrackedAdded, ['added.js']);
});

test('diffSince：没有基线时返回 null', async () => {
  assert.equal(await diffSince({ spawn: () => {}, cwd: 'C:\\repo', baseline: null }), null);
});

test('describeChanges：有改动列文件，无改动明说', () => {
  const withChanges = describeChanges({ changedFiles: ['a.js'], untrackedAdded: ['b.js'], stat: '' });
  assert.match(withChanges, /修改：a\.js/);
  assert.match(withChanges, /新增：b\.js/);
  const none = describeChanges({ changedFiles: [], untrackedAdded: [], stat: '' });
  assert.match(none, /没有检测到改动/);
  assert.equal(describeChanges(null), '');
});
