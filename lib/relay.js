/**
 * 角色接力：claude 先出方案，codex 按方案实现（串行两段）。
 *
 * 为什么需要：高难度任务的失败模式通常是「方向错了但已经改了一堆文件」。
 * 让擅长推理的 claude 先出可执行的改动清单，再让擅长执行的 codex 照着做，
 * 比单发给任何一方都稳。代价是两段串行，成本约等于两次调用。
 *
 * 第一段用 `delivery: 'caller'` 静默拿结果（不给主模型发通知），第二段才回注。
 */

export const RELAY_LEVELS = Object.freeze(['low', 'medium', 'high', 'extreme']);

/** 是否需要接力：路由是方案方、执行方可用且难度达到门槛。 */
export function shouldRelay(input = {}) {
  const { relay, route, level } = input;
  if (!relay || relay.enabled !== true) return false;
  if (route !== relay.planChannel) return false;
  if (input.execEnabled === false) return false;
  const need = RELAY_LEVELS.indexOf(relay.minDifficulty);
  const have = RELAY_LEVELS.indexOf(level);
  if (need < 0 || have < 0) return false;
  return have >= need;
}

/** 从 SubagentResult 里取方案正文。 */
export function extractPlan(result) {
  const blocks = Array.isArray(result?.output) ? result.output : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 给执行段用的提示：在原始目标前面强调「照方案做」。
 * （真正的方案正文由 brief 的 plan 段落承载，这里只给一句衔接。）
 */
export function relayHandoffLine(plan, max = 120) {
  const text = String(plan ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '（上游方案为空，按你自己的判断实现）';
  return `上游方案共 ${text.length} 字，要点：${text.slice(0, max)}${text.length > max ? '…' : ''}`;
}
