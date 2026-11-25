/**
 * 预算护栏：按「今天已花多少（估算）」做闸门。
 *
 * 只能做**事后估算**，做不了事前预测（一次 CLI 调用花多少，跑完才知道）。
 * 所以口径是：累计到今天的估算成本 ≥ 上限，就不再发起新的派发。
 * 上限 `dailyUsd = 0` 表示不限制。
 */

export function todaySpend(runs, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let spent = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    if ((run?.startedAt ?? 0) < from) continue;
    spent += run?.costEstimate?.usd ?? 0;
  }
  return Math.round(spent * 1e6) / 1e6;
}

/**
 * @param {{ runs?: any[], spent?: number, budget?: { enabled?: boolean, dailyUsd?: number }, now?: number,
 *           inFlight?: number, projected?: number }} input
 *   spent 优先（来自独立账本）；inFlight = 已启动未结算的预估合计；projected = 本次要发起的预估。
 *   三者一起算，避免并行/在飞的运行到结算前把额度放穿。
 * @returns {{ ok: boolean, spent: number, limit: number, remaining: number, reason?: string }}
 */
export function checkBudget(input = {}) {
  const runs = Array.isArray(input.runs) ? input.runs : [];
  const budget = input.budget ?? {};
  const spent = typeof input.spent === 'number' && Number.isFinite(input.spent) ? input.spent : todaySpend(runs, input.now);
  const inFlight = Number(input.inFlight) > 0 ? Number(input.inFlight) : 0;
  const projected = Number(input.projected) > 0 ? Number(input.projected) : 0;
  const limit = Number(budget.dailyUsd) > 0 ? Number(budget.dailyUsd) : 0;

  if (budget.enabled === false || limit <= 0) {
    return { ok: true, spent, limit: 0, remaining: Infinity };
  }
  const reserved = Math.round((spent + inFlight + projected) * 1e6) / 1e6;
  const remaining = Math.round(Math.max(0, limit - reserved) * 1e6) / 1e6;
  if (reserved >= limit) {
    const parts = [`今日估算已花 $${spent.toFixed(4)}`];
    if (inFlight > 0) parts.push(`在飞 $${inFlight.toFixed(4)}`);
    if (projected > 0) parts.push(`本次预估 $${projected.toFixed(4)}`);
    return { ok: false, spent, limit, remaining, reason: `${parts.join(' + ')}，达到上限 $${limit.toFixed(2)}` };
  }
  return { ok: true, spent, limit, remaining };
}

/** 给 UI 用的百分比（0–1）。 */
export function budgetUsage(check) {
  if (!check || !check.limit) return 0;
  return Math.max(0, Math.min(1, check.spent / check.limit));
}
