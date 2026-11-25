/**
 * 路由行渲染：每步注入主代理运行时上下文的唯一一行提示。
 *
 * 两种形态：
 *   - 让出中：派发出去后必须明确告诉主代理「别自己再做」，否则它会一边等一边做，成本翻倍；
 *   - 普通：只报告本轮的判定结果（路由 + 理由 + 难度 + 模式）。
 */

const YIELD_TEMPLATE = (scope) =>
  `【子代理路由】本任务${scope}。**本轮不要自己执行同一件事**：不要修改相关文件，只做确认与等待；` +
  '收到完成通知后审阅、核对并汇总给用户；若通知报告失败或中断，再自己接手。';

export function renderRouteLine(input = {}) {
  const { state, cfg, now = Date.now() } = input;
  const auto = cfg?.auto ?? {};

  if (auto.yield !== false && state?.yielded) {
    const minutes = auto.yieldMinutes > 0 ? auto.yieldMinutes : 20;
    const elapsedMin = (now - (state.yielded.at ?? 0)) / 60000;
    if (elapsedMin <= minutes) {
      const who = state.yielded.provider ?? '子代理';
      const targets = Array.isArray(state.yielded.targets) ? state.yielded.targets : [];
      const scope = targets.length
        ? `已交给 ${who}（${state.yielded.partLabel ?? '并行'}），负责 ${targets.join('、')}`
        : `已交给 ${who}${state.yielded.relay ? '（方案→执行两段）' : ''}`;
      return YIELD_TEMPLATE(scope);
    }
  }

  const decision = state?.current;
  if (!decision) return '';
  const route = decision.route === 'self' ? '自己干' : decision.route;
  const level = state.difficulty?.level ? `；难度 ${state.difficulty.level}` : '';
  const mode = auto.mode === 'dispatch' ? '会派发' : '仅观察';
  return `【子代理路由】本轮：${route}（${decision.reason}）${level}；${mode}`;
}
