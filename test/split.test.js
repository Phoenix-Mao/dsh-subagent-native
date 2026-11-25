import test from 'node:test';
import assert from 'node:assert/strict';

import { describePart, extractTargets, splitTargets } from '../lib/split.js';

test('extractTargets：抽出路径并去重保序', () => {
  const targets = extractTargets('改 D:\\proj\\app\\a.cs 和 src/b.js，再看 D:\\proj\\app\\a.cs');
  assert.deepEqual(targets, ['D:\\proj\\app\\a.cs', 'src/b.js']);
});

test('extractTargets：中文标点后的路径也认', () => {
  assert.deepEqual(extractTargets('检查：D:/work/x.cs、lib/y.ts'), ['D:/work/x.cs', 'lib/y.ts']);
});

test('extractTargets：没有路径返回空', () => {
  assert.deepEqual(extractTargets('重构一下通信层'), []);
});

test('splitTargets：目标不足两个不扇出', () => {
  assert.equal(splitTargets('改一下 D:\\w\\a.cs'), null);
  assert.equal(splitTargets('重构通信层'), null);
});

test('splitTargets：三个目标按 maxParts 分组', () => {
  const result = splitTargets('改 a/x.cs、b/y.cs、c/z.cs 这三个文件', { maxParts: 3 });
  assert.ok(result);
  assert.equal(result.targets.length, 3);
  assert.equal(result.parts.length, 3);
  assert.deepEqual(result.parts.map((part) => part.targets.length), [1, 1, 1]);
  assert.deepEqual(result.parts.map((part) => part.index), [1, 2, 3]);
  assert.ok(result.parts.every((part) => part.total === 3));
});

test('splitTargets：目标多于 maxParts 时合并，且同一文件不跨组', () => {
  const prompt = '改 a/1.cs、a/2.cs、a/3.cs、a/4.cs、a/5.cs';
  const result = splitTargets(prompt, { maxParts: 2 });
  assert.ok(result);
  assert.equal(result.parts.length, 2);
  const flat = result.parts.flatMap((part) => part.targets);
  assert.equal(flat.length, 5);
  assert.equal(new Set(flat).size, 5, '没有重复目标');
  // 每组都不超过 ceil(5/2)=3
  assert.ok(result.parts.every((part) => part.targets.length <= 3));
});

test('splitTargets：目标数受 MAX_TARGETS 限制', () => {
  const prompt = Array.from({ length: 30 }, (_, index) => `d${index}/f${index}.cs`).join('、');
  const result = splitTargets(prompt, { maxParts: 4 });
  assert.ok(result);
  assert.ok(result.targets.length <= 12);
});

test('splitTargets：maxParts=1 表示不扇出（不要抬到 2）', () => {
  assert.equal(splitTargets('改 a/x.cs、b/y.cs', { maxParts: 1 }), null);
  assert.equal(splitTargets('改 a/x.cs、b/y.cs', { maxParts: 0 }), null);
});

test('splitTargets：Windows 斜杠别名算同一个文件，不拆到两份', () => {
  const result = splitTargets(String.raw`改 src/a.js、src\a.js、src\b.js`, { maxParts: 3 });
  assert.ok(result);
  assert.equal(result.targets.length, 2, `实际 ${JSON.stringify(result.targets)}`);
  assert.equal(result.targets[0], 'src/a.js');
});

test('describePart：给出「第几份/共几份 + 目标」', () => {
  assert.equal(describePart({ index: 2, total: 3, targets: ['a.cs', 'b.cs'] }), '第 2/3 份：a.cs、b.cs');
});
