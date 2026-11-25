import test from 'node:test';
import assert from 'node:assert/strict';

import { budgetUsage, checkBudget, todaySpend } from '../lib/budget.js';

const now = new Date('2026-11-25T12:00:00').getTime();
const today = new Date('2026-11-25T09:00:00').getTime();
const yesterday = new Date('2026-11-24T23:00:00').getTime();

const runs = [
  { startedAt: today, costEstimate: { usd: 0.01 } },
  { startedAt: today + 1000, costEstimate: { usd: 0.02 } },
  { startedAt: yesterday, costEstimate: { usd: 0.5 } },
  { startedAt: today, costEstimate: null },
];

test('todaySpend：只算今天、无估算的跳过', () => {
  assert.equal(todaySpend(runs, now), 0.03);
  assert.equal(todaySpend([], now), 0);
});

test('checkBudget：未启用或上限为 0 时不拦', () => {
  assert.equal(checkBudget({ runs, budget: { enabled: false, dailyUsd: 1 }, now }).ok, true);
  assert.equal(checkBudget({ runs, budget: { enabled: true, dailyUsd: 0 }, now }).ok, true);
});

test('checkBudget：超过上限即拒绝并给出原因', () => {
  const result = checkBudget({ runs, budget: { enabled: true, dailyUsd: 0.02 }, now });
  assert.equal(result.ok, false);
  assert.equal(result.spent, 0.03);
  assert.equal(result.limit, 0.02);
  assert.equal(result.remaining, 0);
  assert.match(result.reason, /达到上限/);
});

test('checkBudget：未超时放行并给出剩余额度', () => {
  const result = checkBudget({ runs, budget: { enabled: true, dailyUsd: 1 }, now });
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 0.97);
});

test('checkBudget：把在飞与本次预占一起算，并发不会放穿', () => {
  // 已花 0.02，在飞 0.02，本次预估 0.02 → 合计 0.06 ≥ 0.05 上限
  const blocked = checkBudget({ spent: 0.02, inFlight: 0.02, projected: 0.02, budget: { enabled: true, dailyUsd: 0.05 } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /在飞/);
  assert.match(blocked.reason, /本次预估/);
  // 只有已花时仍然放行
  const ok = checkBudget({ spent: 0.02, budget: { enabled: true, dailyUsd: 0.05 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 0.03);
});

test('budgetUsage：百分比，未设置上限时为 0', () => {
  assert.equal(budgetUsage({ spent: 0.03, limit: 0.06 }), 0.5);
  assert.equal(budgetUsage({ spent: 0.03, limit: 0 }), 0);
  assert.equal(budgetUsage(null), 0);
  assert.equal(budgetUsage({ spent: 2, limit: 1 }), 1);
});
