import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDecisionLog } from '../lib/decisions.js';
import { createHistoryStore } from '../lib/history.js';

function tempFile(name = 'decisions.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-native-dec-'));
  return path.join(dir, name);
}

test('decision log：追加后可读回，重启后仍能恢复', () => {
  const file = tempFile();
  const log = createDecisionLog({ file });
  log.append({ at: 1, route: 'codex', action: 'dispatch' });
  log.append({ at: 2, route: 'self', action: 'yield' });
  assert.deepEqual(log.load().map((row) => row.route), ['codex', 'self']);
  const reopened = createDecisionLog({ file });
  assert.equal(reopened.load().length, 2);
});

test('decision log：坏行跳过，文件不存在返回空', () => {
  const file = tempFile();
  fs.writeFileSync(file, 'not json\n{"at":1,"route":"self"}\n', 'utf8');
  const log = createDecisionLog({ file });
  assert.equal(log.load().length, 1);
  assert.deepEqual(createDecisionLog({ file: tempFile('missing.jsonl') }).load(), []);
});

test('decision log：超过上限后原子压缩，保留最近若干条且无临时文件残留', () => {
  const file = tempFile();
  const log = createDecisionLog({ file, maxBytes: 64 * 1024, keep: 20 });
  for (let i = 0; i < 400; i += 1) log.append({ at: i, route: 'self', pad: 'x'.repeat(80) });
  const rows = log.load(400);
  assert.ok(rows.length <= 400);
  assert.ok(rows.length >= 20, `压缩后条数 ${rows.length}`);
  assert.equal(rows[rows.length - 1].at, 399, '最后一条必须保留');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '不应留下临时文件');
});

test('history store：超过阈值后压缩为最近 limit 条，且不留临时文件', () => {
  const file = tempFile('runs.jsonl');
  const store = createHistoryStore({ file, limit: 5, compactBytes: 64 * 1024 });
  for (let i = 0; i < 300; i += 1) store.append({ id: `r${i}`, pad: 'y'.repeat(80) });
  const rows = store.load();
  assert.deepEqual(rows.map((row) => row.id), ['r295', 'r296', 'r297', 'r298', 'r299']);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('history store：读失败时不把空内容写回（ndjson 不被清空）', () => {
  const file = tempFile('runs.jsonl');
  const store = createHistoryStore({ file, limit: 10, compactBytes: 1024 });
  store.append({ id: 'a', pad: 'z'.repeat(2000) });
  assert.equal(store.compact(), true);
  assert.deepEqual(store.load().map((row) => row.id), ['a']);
});
