import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PRICING,
  basisForChannel,
  buildRecord,
  createHistoryStore,
  estimateCost,
  estimateFailedCost,
  isCustomPricing,
  medianCost,
  mergePricing,
  pricingForChannel,
  projectCost,
  preview,
  summarize,
} from '../lib/history.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-native-'));
  return path.join(dir, 'runs.jsonl');
}

test('buildRecord：字段齐全，含用量、成本估算与截断预览', () => {
  const record = buildRecord({
    id: 'r1',
    startedAt: 1000,
    endedAt: 2500,
    channel: 'codex',
    provider: 'native-codex',
    model: 'gpt-6.2-sol',
    effort: 'high',
    cwd: 'D:\\work',
    trigger: 'framework',
    parentSession: 'abcdefgh12345678',
    prompt: 'x'.repeat(500),
    answer: 'y'.repeat(500),
    usage: { input: 1_000_000, cached: 1_000_000, cacheWrite: 0, output: 1_000_000 },
    stopReason: 'completed',
    exitCode: 0,
    eventCount: 9,
    problems: [],
    stderrTail: 'err',
  });

  assert.equal(record.durationMs, 1500);
  assert.equal(record.channel, 'codex');
  assert.equal(record.trigger, 'framework');
  assert.equal(record.parentSession, '12345678', '父会话只留后 8 位');
  assert.equal(record.promptChars, 500);
  assert.ok(record.promptPreview.endsWith('…'));
  assert.equal(record.answerChars, 500);
  assert.equal(record.usage.input, 1_000_000);
  // codex 1 折：input 1M 含 cached 1M → 普通输入 0 + 缓存读 1M×$0.01 + 输出 1M×$1.0 = $1.01
  assert.equal(record.costEstimate.basis, 'codex-1zhe');
  assert.equal(record.costEstimate.usd, 1.01);
});

test('estimateCost：1 小时缓存写按 1.6 倍计', () => {
  const oneHour = estimateCost({ input: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000, output: 0 }, 'claude-4zhe');
  assert.equal(oneHour, 3.2, '$2.00 × 1.6 = $3.20');
  const fiveMin = estimateCost({ input: 0, cacheWrite: 1_000_000, cacheWrite1h: 0, output: 0 }, 'claude-4zhe');
  assert.equal(fiveMin, 2.0);
  // 混合：一半 1h 一半 5m
  const mixed = estimateCost({ input: 0, cacheWrite: 2_000_000, cacheWrite1h: 1_000_000, output: 0 }, 'claude-4zhe');
  assert.equal(mixed, 5.2);
});

test('estimateCost：codex 的 input 含缓存，需先减掉再计普通输入价', () => {
  // codex: (1M input 含 1M cached) → 普通输入 0 token，缓存 1M×$0.01，输出 1M×$1.0
  const codex = estimateCost({ input: 1_000_000, cached: 1_000_000, cacheWrite: 0, output: 1_000_000 }, 'codex-1zhe');
  assert.equal(codex, 1.01);
  // 与实际账单核对过的一行：input 31,756（含 4,928 cached）/ output 8，实收 $0.005423
  const billed = estimateCost({ input: 31_756, cached: 4_928, output: 8 }, 'codex-1zhe');
  assert.ok(Math.abs(billed - 0.005423) < 0.000002, `估算 ${billed} 应约等于账单 0.005423`);
  // claude 的 input 不含缓存，不减
  const claude = estimateCost({ input: 1_000_000, cached: 1_000_000, output: 0 }, 'claude-4zhe');
  assert.equal(claude, 1.68);
  assert.equal(estimateCost({ input: 1, output: 1 }, 'unknown'), null);
  assert.equal(estimateCost(null, 'codex-1zhe'), null);
});

test('basisForChannel：通道 → 价目表', () => {
  assert.equal(basisForChannel('codex'), 'codex-1zhe');
  assert.equal(basisForChannel('claude'), 'claude-4zhe');
  assert.equal(basisForChannel('other'), 'unknown');
});

test('pricingForChannel：无覆盖时返回内置价目，不打 custom 标', () => {
  const codex = pricingForChannel('codex');
  assert.equal(codex.input, DEFAULT_PRICING['codex-1zhe'].input);
  assert.equal(codex.inputIncludesCached, true);
  assert.equal(isCustomPricing(codex), false);
  assert.equal(pricingForChannel('other'), null);
});

test('pricingForChannel：用户覆盖只替换给到的字段，其余保留内置', () => {
  const custom = pricingForChannel('codex', { codex: { input: 0.5, output: 2.5 } });
  assert.equal(custom.input, 0.5);
  assert.equal(custom.output, 2.5);
  assert.equal(custom.cacheRead, DEFAULT_PRICING['codex-1zhe'].cacheRead, '没覆盖的字段沿用内置');
  assert.equal(custom.inputIncludesCached, true, '通道口径不因价格覆盖而丢');
  assert.equal(isCustomPricing(custom), true);
});

test('mergePricing：非法数值被忽略，不会让配置炸掉', () => {
  const base = DEFAULT_PRICING['claude-4zhe'];
  const merged = mergePricing(base, { input: 'abc', output: -1, cacheRead: '0.05' });
  assert.equal(merged.input, base.input, '非数值忽略');
  assert.equal(merged.output, base.output, '负数忽略');
  assert.equal(merged.cacheRead, 0.05, '数字字符串照收');
  assert.equal(isCustomPricing(merged), true);
  assert.equal(mergePricing(base, null), base);
  assert.equal(mergePricing(base, {}).custom, undefined, '空覆盖不打标');
});

test('estimateCost：接受自定义价目对象，口径按 inputIncludesCached 走', () => {
  const custom = { input: 1, output: 2, cacheWrite: 3, cacheRead: 0.1, inputIncludesCached: true };
  // 1M input 含 1M cached → 普通输入 0 + 缓存 1M×$0.1 = $0.1
  assert.equal(estimateCost({ input: 1_000_000, cached: 1_000_000, output: 0 }, custom), 0.1);
  // 同样的价目但改成「input 不含缓存」→ 输入 1M×$1 + 缓存 1M×$0.1 = $1.1
  assert.equal(
    estimateCost({ input: 1_000_000, cached: 1_000_000, output: 0 }, { ...custom, inputIncludesCached: false }),
    1.1,
  );
  // 缺价格的残缺对象不估算
  assert.equal(estimateCost({ input: 1, output: 1 }, {}), null);
});

test('estimateCost：自定义 1 小时缓存系数生效', () => {
  const price = { input: 0, output: 0, cacheWrite: 1, cacheRead: 0, cacheWrite1hFactor: 2 };
  assert.equal(estimateCost({ input: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000, output: 0 }, price), 2);
});

test('buildRecord：自定义价目下成本按自定义算，并标记 custom', () => {
  const record = buildRecord({
    id: 'custom',
    startedAt: 0,
    endedAt: 1000,
    channel: 'codex',
    usage: { input: 1_000_000, cached: 0, output: 0 },
    pricing: { input: 2, output: 0, cacheWrite: 0, cacheRead: 0, inputIncludesCached: true, custom: true },
  });
  assert.equal(record.costEstimate.usd, 2, '1M × $2 = $2');
  assert.equal(record.costEstimate.custom, true);
  assert.equal(record.costEstimate.basis, 'codex-1zhe', 'basis 仍记录通道来源，便于对账');
  // 不传 pricing 时退回内置价目，不带 custom 标
  const builtin = buildRecord({ id: 'builtin', startedAt: 0, endedAt: 1, channel: 'codex', usage: { input: 1_000_000, output: 0 } });
  assert.equal(builtin.costEstimate.custom, undefined);
  assert.equal(builtin.costEstimate.usd, 0.2);
});

test('preview：压缩空白并截断', () => {
  assert.equal(preview('  a\n\nb  '), 'a b');
  assert.ok(preview('x'.repeat(300), 10).endsWith('…'));
});

test('history store：追加/读回/清空，坏行跳过', () => {
  const file = tempFile();
  const store = createHistoryStore({ file });
  store.append({ id: 'a', startedAt: 1 });
  store.append({ id: 'b', startedAt: 2 });
  fs.appendFileSync(file, 'not json\n', 'utf8');
  const rows = store.load();
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
  store.clear();
  assert.equal(store.load().length, 0);
});

test('summarize：今日计数、通道分布、触发来源、token 汇总、成本合计', () => {
  const now = new Date('2026-11-25T12:00:00').getTime();
  const today = new Date('2026-11-25T09:00:00').getTime();
  const yesterday = new Date('2026-11-24T23:00:00').getTime();
  const runs = [
    {
      id: 'a',
      startedAt: today,
      durationMs: 1000,
      channel: 'codex',
      trigger: 'framework',
      usage: { input: 100, cached: 50, output: 10 },
      costEstimate: { usd: 0.01 },
      stopReason: 'completed',
    },
    {
      id: 'b',
      startedAt: today + 1000,
      durationMs: 3000,
      channel: 'claude',
      trigger: 'model',
      usage: { input: 200, cached: 0, output: 20 },
      costEstimate: { usd: 0.02 },
      stopReason: 'error',
    },
    {
      id: 'c',
      startedAt: yesterday,
      durationMs: 5000,
      channel: 'codex',
      trigger: 'model',
      usage: { input: 300, cached: 0, output: 30 },
      costEstimate: { usd: 0.03 },
      stopReason: 'completed',
    },
  ];
  const summary = summarize(runs, now);
  assert.equal(summary.total, 3);
  assert.equal(summary.today, 2);
  assert.deepEqual(summary.byChannel, { codex: 1, claude: 1 });
  assert.deepEqual(summary.byTrigger, { framework: 1, model: 1 });
  assert.equal(summary.avgDurationMs, 2000);
  assert.deepEqual(summary.tokens, { input: 300, cached: 50, output: 30 });
  assert.equal(summary.estimatedCostUsd, 0.03);
  assert.equal(summary.failures, 1);
});

test('buildRecord：扇出信息被记录', () => {
  const record = buildRecord({
    id: 'r2',
    startedAt: 1,
    endedAt: 2,
    channel: 'codex',
    provider: 'native-codex',
    trigger: 'framework',
    fanout: { index: 2, total: 3 },
    prompt: 'x',
    answer: 'y',
  });
  assert.deepEqual(record.fanout, { index: 2, total: 3 });
  const single = buildRecord({ id: 'r3', startedAt: 1, endedAt: 2, channel: 'codex', trigger: 'model' });
  assert.equal(single.fanout, null);
});

test('estimateFailedCost：按耗时外推，超时运行不再被低估', () => {
  const runs = [
    { channel: 'codex', durationMs: 10_000, costEstimate: { usd: 0.01 } }, // $0.001/s
    { channel: 'codex', durationMs: 20_000, costEstimate: { usd: 0.02 } }, // $0.001/s
    { channel: 'codex', durationMs: 30_000, costEstimate: { usd: 0.09 } }, // $0.003/s
  ];
  // 跑 20 分钟（1,200,000 ms）：中位速率 $0.001/s → $1.2，p90 速率 $0.003/s 封顶
  const long = estimateFailedCost(runs, 'codex', 20 * 60_000, { capMs: 20 * 60_000 });
  assert.ok(long > 1.0, `应外推到约 1.2 美元，实际 ${long}`);
  // 短运行按短算
  const short = estimateFailedCost(runs, 'codex', 5_000);
  assert.ok(short < 0.01, `应为几毫美元，实际 ${short}`);
  // 样本不足/无样本
  assert.equal(estimateFailedCost([], 'codex', 60_000), null);
  assert.equal(estimateFailedCost([{ channel: 'claude', durationMs: 1000, costEstimate: { usd: 0.1 } }], 'codex', 1000), null);
});

test('projectCost：同通道 p75，用于事前预占', () => {
  const runs = [
    { channel: 'codex', costEstimate: { usd: 0.01 } },
    { channel: 'codex', costEstimate: { usd: 0.02 } },
    { channel: 'codex', costEstimate: { usd: 0.03 } },
    { channel: 'codex', costEstimate: { usd: 0.04 } },
    { channel: 'claude', costEstimate: { usd: 0.9 } },
  ];
  const p75 = projectCost(runs, 'codex');
  assert.ok(p75 >= 0.03 && p75 <= 0.04, `p75 应在 0.03–0.04，实际 ${p75}`);
  assert.equal(projectCost(runs, 'gemini'), null);
});

test('medianCost：按通道取中位数，无样本返回 null', () => {
  const runs = [
    { channel: 'codex', costEstimate: { usd: 0.01 } },
    { channel: 'codex', costEstimate: { usd: 0.03 } },
    { channel: 'codex', costEstimate: { usd: 0.02 } },
    { channel: 'claude', costEstimate: { usd: 0.5 } },
    { channel: 'codex', costEstimate: { usd: null } },
  ];
  assert.equal(medianCost(runs, 'codex'), 0.02);
  assert.equal(medianCost(runs, 'claude'), 0.5);
  assert.equal(medianCost(runs, 'gemini'), null);
  assert.equal(medianCost([], 'codex'), null);
  // 偶数个样本取中间两个的平均
  assert.equal(medianCost([{ channel: 'codex', costEstimate: { usd: 0.01 } }, { channel: 'codex', costEstimate: { usd: 0.02 } }], 'codex'), 0.015);
});

test('buildRecord：接力阶段被记录', () => {
  const plan = buildRecord({ id: 'r4', startedAt: 1, endedAt: 2, channel: 'claude', trigger: 'framework', relay: 'plan' });
  assert.equal(plan.relay, 'plan');
  const exec = buildRecord({ id: 'r5', startedAt: 1, endedAt: 2, channel: 'codex', trigger: 'framework', relay: 'exec' });
  assert.equal(exec.relay, 'exec');
  assert.equal(buildRecord({ id: 'r6', startedAt: 1, endedAt: 2, channel: 'codex' }).relay, null);
});

test('summarize：空输入不炸', () => {
  const summary = summarize([], Date.now());
  assert.equal(summary.today, 0);
  assert.deepEqual(summary.byChannel, {});
  assert.equal(summary.estimatedCostUsd, 0);
});
