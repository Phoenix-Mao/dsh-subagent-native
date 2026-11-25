import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RULES,
  decideByRules,
  isUnderPath,
  matchCondition,
  normalizePath,
  validateRules,
} from '../lib/rules.js';

test('normalizePath 归一 Windows 路径', () => {
  assert.equal(normalizePath('D:/proj/app/'), 'd:\\proj\\app');
  assert.equal(normalizePath('\\\\?\\D:\\x'), 'd:\\x');
  // 盘符根归一后不带尾分隔符，仍能正确做前缀比较
  assert.equal(normalizePath('D:\\'), 'd:');
  assert.equal(isUnderPath('D:\\x\\y.cs', 'D:\\'), true);
  assert.equal(normalizePath(''), '');
});

test('isUnderPath 不把前缀相同但更长的目录算作子目录', () => {
  assert.equal(isUnderPath('D:\\proj\\app\\a.cs', 'D:\\proj'), true);
  assert.equal(isUnderPath('D:\\proj', 'D:\\proj'), true);
  assert.equal(isUnderPath('D:\\proj_old\\a.cs', 'D:\\proj'), false);
  assert.equal(isUnderPath('D:\\other\\a.cs', 'D:\\proj'), false);
});

test('matchCondition：多条件为 AND', () => {
  const m = { cwdPrefix: 'D:\\proj', anyKeyword: ['修'] };
  assert.equal(matchCondition(m, { prompt: '修一下日志', cwd: 'D:\\proj\\app' }), true);
  assert.equal(matchCondition(m, { prompt: '修一下日志', cwd: 'D:\\other' }), false);
  assert.equal(matchCondition(m, { prompt: '看一下日志', cwd: 'D:\\proj\\app' }), false);
});

test('matchCondition：minFiles / minPromptChars', () => {
  assert.equal(matchCondition({ minFiles: 6 }, { prompt: 'x', fileCount: 6 }), true);
  assert.equal(matchCondition({ minFiles: 6 }, { prompt: 'x', fileCount: 5 }), false);
  assert.equal(matchCondition({ minPromptChars: 4 }, { prompt: '四个字符' }), true);
  assert.equal(matchCondition({ minPromptChars: 4 }, { prompt: '短' }), false);
});

test('DEFAULT_RULES：重构/评审类去 claude（不依赖任何作者本机路径）', () => {
  const r = decideByRules(DEFAULT_RULES, {
    prompt: '重构 通信层',
    cwd: 'D:\\proj\\app',
  });
  assert.equal(r.route, 'claude');
});

test('DEFAULT_RULES：执行类去 codex，且默认规则里不含本机绝对路径', () => {
  const serialized = JSON.stringify(DEFAULT_RULES);
  assert.ok(!/[A-Za-z]:[\\/]/.test(serialized), '默认规则不应写死任何本机绝对路径');
  const r = decideByRules(DEFAULT_RULES, { prompt: '跑一下测试并复现这个报错', cwd: 'C:\\work' });
  assert.equal(r.route, 'codex');
});

test('DEFAULT_RULES：普通问答兜底为 self', () => {
  const r = decideByRules(DEFAULT_RULES, { prompt: '查一下 dsh 的版本号', cwd: 'C:\\tmp' });
  assert.equal(r.route, 'self');
});

test('decideByRules：未命中返回 null', () => {
  assert.equal(decideByRules([{ match: { anyKeyword: ['zzz'] }, route: 'codex' }], { prompt: 'aaa' }), null);
  assert.equal(decideByRules([], { prompt: 'aaa' }), null);
});

test('validateRules：拒绝非法 route 与未知键', () => {
  assert.throws(() => validateRules([{ match: {}, route: 'gpt' }]), /route 必须是/);
  assert.throws(() => validateRules([{ match: { keyword: ['x'] }, route: 'codex' }]), /未知键/);
  assert.throws(() => validateRules([{ match: { anyKeyword: 'x' }, route: 'codex' }]), /字符串数组/);
  assert.doesNotThrow(() => validateRules(DEFAULT_RULES));
});
