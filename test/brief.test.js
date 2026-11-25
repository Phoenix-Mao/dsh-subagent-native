import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONSTRAINTS, buildBrief, truncate } from '../lib/brief.js';

const base = { prompt: '把 Form1.cs 里的按钮改名', cwd: 'D:\\proj\\app' };

test('buildBrief：包含目标、目录、边界、验收、输出', () => {
  const brief = buildBrief(base);
  assert.match(brief, /## 目标/);
  assert.match(brief, /把 Form1\.cs 里的按钮改名/);
  assert.match(brief, /## 工作目录/);
  assert.match(brief, /D:\\proj\\app/);
  assert.match(brief, /## 边界/);
  assert.match(brief, /## 验收/);
  assert.match(brief, /## 输出/);
});

test('buildBrief：边界里明确禁止遍历仓库（成本控制的关键）', () => {
  const brief = buildBrief(base);
  assert.match(brief, /不要遍历整个仓库/);
  assert.ok(DEFAULT_CONSTRAINTS.some((item) => item.includes('超出预期')));
});

test('buildBrief：带相关文件与失败证据', () => {
  const brief = buildBrief({
    ...base,
    files: [{ path: 'D:\\proj\\app\\Form1.cs', note: '刚改过' }],
    failures: [{ tool: 'pwsh', target: 'dotnet build', firstLine: 'error CS1002' }],
  });
  assert.match(brief, /本会话最近碰过的文件/);
  assert.match(brief, /Form1\.cs（刚改过）/);
  assert.match(brief, /最近的失败证据/);
  assert.match(brief, /error CS1002/);
});

test('buildBrief：没有文件/失败时不出现空段落', () => {
  const brief = buildBrief(base);
  assert.doesNotMatch(brief, /本会话最近碰过的文件/);
  assert.doesNotMatch(brief, /最近的失败证据/);
});

test('buildBrief：相关文件数量受 maxFiles 限制', () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}.cs` }));
  const brief = buildBrief({ ...base, files, maxFiles: 3 });
  assert.match(brief, /f0\.cs/);
  assert.match(brief, /f2\.cs/);
  assert.doesNotMatch(brief, /f3\.cs/);
});

test('buildBrief：总长受 maxChars 限制', () => {
  const brief = buildBrief({ ...base, prompt: 'x'.repeat(20000) });
  assert.ok(brief.length <= 8000, `长度 ${brief.length}`);
  const custom = buildBrief({ ...base, prompt: 'y'.repeat(20000), maxChars: 1200 });
  assert.ok(custom.length <= 1200, `长度 ${custom.length}`);
});

test('buildBrief：方案很长时，边界/验收/输出/文件段仍然完整（分段额度）', () => {
  const brief = buildBrief({
    ...base,
    maxChars: 2000,
    prompt: '改 A.cs 和 B.cs',
    plan: 'P'.repeat(8000),
    files: [{ path: 'D:\\w\\A.cs', note: '刚改过' }],
    failures: [{ tool: 'pwsh', target: 'build', firstLine: 'CS1002' }],
  });
  assert.ok(brief.length <= 2000, `长度 ${brief.length}`);
  assert.match(brief, /## 边界/, '边界段被挤掉了');
  assert.match(brief, /不要遍历整个仓库/);
  assert.match(brief, /## 验收/);
  assert.match(brief, /## 输出/);
  assert.match(brief, /## 本会话最近碰过的文件/, '文件段被挤掉了');
  assert.match(brief, /## 上游方案/);
  assert.match(brief, /已截断/);
});

test('buildBrief：方案段预算大于目标段（权重 0.5 vs 0.35）', () => {
  const brief = buildBrief({
    ...base,
    maxChars: 1200,
    prompt: 'P'.repeat(3000),
    plan: 'Q'.repeat(3000),
  });
  const planBlock = brief.slice(brief.indexOf('## 上游方案'), brief.indexOf('## 输出'));
  const promptBlock = brief.slice(brief.indexOf('## 目标'), brief.indexOf('## 工作目录'));
  assert.ok(planBlock.length > promptBlock.length, `方案 ${planBlock.length} 应大于目标 ${promptBlock.length}`);
});

test('buildBrief：planner 角色只出方案、不出现验收段', () => {
  const brief = buildBrief({ ...base, role: 'planner' });
  assert.match(brief, /方案设计者/);
  assert.match(brief, /只出方案，不写代码/);
  assert.doesNotMatch(brief, /## 验收/);
  assert.match(brief, /改动清单/);
});

test('buildBrief：扇出时给出「第几份/共几份」和目标清单', () => {
  const brief = buildBrief({
    ...base,
    targets: ['a.cs', 'b.cs'],
    part: { index: 2, total: 3, targets: ['a.cs', 'b.cs'] },
  });
  assert.match(brief, /你负责的目标/);
  assert.match(brief, /第 2\/3 份/);
  assert.match(brief, /- a\.cs/);
  assert.match(brief, /- b\.cs/);
});

test('buildBrief：单发时不出现「第几份」', () => {
  const brief = buildBrief({ ...base, targets: [] });
  assert.doesNotMatch(brief, /第 \d+\/\d+ 份/);
});

test('buildBrief：空输入也给得出可用简报', () => {
  const brief = buildBrief();
  assert.match(brief, /调用方未提供目标描述/);
  assert.match(brief, /## 边界/);
});

test('truncate：超长才截断并标注原长', () => {
  assert.equal(truncate('abc', 10), 'abc');
  const cut = truncate('abcdefghij', 4);
  assert.match(cut, /^abcd/);
  assert.match(cut, /原长 10 字符/);
});
