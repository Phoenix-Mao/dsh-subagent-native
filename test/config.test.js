import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, mergeConfig, normalizePatch, resolveConfig } from '../lib/config.js';

test('resolveConfig：空配置给出安全默认值', () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.auto.mode, 'observe', '默认只观察，不自动派发');
  assert.equal(cfg.auto.yield, true);
  assert.deepEqual(cfg.auto.thresholds, { claude: 'high', codex: 'medium' });
  assert.equal(cfg.team.enabled, false);
  assert.equal(cfg.relay.enabled, false);
  assert.equal(cfg.budget.dailyUsd, 2, '默认要有预算上限');
  assert.equal(cfg.claude.permissionMode, 'plan', '默认只读，写模式需显式开启');
  assert.equal(cfg.codex.sandbox, 'read-only', '默认只读，不继承原生配置');
  assert.equal(cfg.codex.timeoutMinutes, 20);
  assert.equal(cfg.brief.maxChars, 8000);
  assert.equal(cfg.brief.planChars, 6000);
});

test('resolveConfig：显式配置可以放开到可写', () => {
  const cfg = resolveConfig({
    claude: { permissionMode: 'acceptEdits' },
    codex: { sandbox: 'workspace-write' },
    budget: { dailyUsd: 0 },
  });
  assert.equal(cfg.claude.permissionMode, 'acceptEdits');
  assert.equal(cfg.codex.sandbox, 'workspace-write');
  assert.equal(cfg.budget.dailyUsd, 0, '0 表示显式关闭上限');
});

test('resolveConfig：价目默认取内置值，换站可用 config.pricing 覆盖', () => {
  const fallback = resolveConfig({});
  assert.equal(fallback.pricing.codex.input, 0.2);
  assert.equal(fallback.pricing.claude.input, 1.6);
  assert.equal(fallback.pricing.codex.custom, undefined, '没覆盖就不打 custom 标');

  const custom = resolveConfig({ pricing: { codex: { input: 0.8, output: 4 } } });
  assert.equal(custom.pricing.codex.input, 0.8);
  assert.equal(custom.pricing.codex.output, 4);
  assert.equal(custom.pricing.codex.cacheRead, 0.01, '未覆盖字段沿用内置');
  assert.equal(custom.pricing.codex.custom, true);
  assert.equal(custom.pricing.claude.custom, undefined, '只覆盖 codex 不影响 claude');
});

test('resolveConfig：越界值被收敛而不是报错', () => {
  const cfg = resolveConfig({
    auto: { thresholds: { claude: 'nonsense', codex: 'low' } },
    team: { maxParallel: 99 },
    relay: { planChannel: 'gemini', planTimeoutMinutes: 99999 },
    codex: { timeoutMinutes: -5 },
  });
  assert.equal(cfg.auto.thresholds.claude, 'high');
  assert.equal(cfg.auto.thresholds.codex, 'low');
  assert.equal(cfg.team.maxParallel, 6);
  assert.equal(cfg.relay.planChannel, 'claude');
  assert.equal(cfg.relay.planTimeoutMinutes, 10);
  assert.equal(cfg.codex.timeoutMinutes, 20);
});

test('normalizePatch：只接受白名单字段，其余忽略', () => {
  const next = normalizePatch({ auto: { mode: 'dispatch', unknown: 1 }, codex: { model: ' x ', sandbox: 'read-only' }, evil: { x: 1 } });
  assert.deepEqual(next, { auto: { mode: 'dispatch' }, codex: { model: 'x', sandbox: 'read-only' } });
});

test('normalizePatch：越界取值抛错并说明原因', () => {
  assert.throws(() => normalizePatch({ auto: { mode: 'nope' } }), /observe \/ dispatch/);
  assert.throws(() => normalizePatch({ auto: { thresholds: { codex: 'huge' } } }), /thresholds\.codex/);
  assert.throws(() => normalizePatch({ team: { maxParallel: 9 } }), /1–6/);
  assert.throws(() => normalizePatch({ budget: { dailyUsd: -1 } }), /非负数/);
  assert.throws(() => normalizePatch({ relay: { planChannel: 'gemini' } }), /planChannel/);
  assert.throws(() => normalizePatch({ codex: { effort: 'ultra2' } }), /codex effort/);
  assert.throws(() => normalizePatch({ claude: { permissionMode: 'yolo' } }), /permissionMode/);
});

test('mergeConfig：嵌套段合并，thresholds 单独合并，未涉及字段保留', () => {
  const current = { auto: { mode: 'observe', thresholds: { claude: 'high', codex: 'medium' }, yield: false }, team: { enabled: true } };
  const inherited = { history: { limit: 1000 } };
  const merged = mergeConfig(current, inherited, { auto: { thresholds: { codex: 'low' } }, budget: { dailyUsd: 2 } });
  assert.equal(merged.auto.mode, 'observe');
  assert.equal(merged.auto.yield, false);
  assert.deepEqual(merged.auto.thresholds, { claude: 'high', codex: 'low' });
  assert.equal(merged.team.enabled, true);
  assert.deepEqual(merged.history, { limit: 1000 });
  assert.equal(merged.budget.dailyUsd, 2);
});

test('normalizePatch：brief 长度预算', () => {
  assert.deepEqual(normalizePatch({ brief: { maxChars: 9000, planChars: 5000 } }), { brief: { maxChars: 9000, planChars: 5000 } });
  assert.throws(() => normalizePatch({ brief: { maxChars: 100 } }), /≥ 500/);
});

test('resolveConfig：默认不注册 provider（工具不可见），需显式开启', () => {
  assert.equal(resolveConfig({}).tools.enabled, false);
  assert.equal(resolveConfig({ tools: { enabled: true } }).tools.enabled, true);
});

test('normalizePatch：可以打开/关闭工具暴露', () => {
  assert.deepEqual(normalizePatch({ tools: { enabled: true } }), { tools: { enabled: true } });
  assert.deepEqual(normalizePatch({ tools: { enabled: false } }), { tools: { enabled: false } });
});

test('LEVELS：难度梯度完整且有序', () => {
  assert.deepEqual([...LEVELS], ['low', 'medium', 'high', 'extreme']);
});
