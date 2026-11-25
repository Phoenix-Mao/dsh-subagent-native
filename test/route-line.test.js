import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRouteLine } from '../lib/route-line.js';

const cfg = { auto: { yield: true, yieldMinutes: 20, mode: 'dispatch' } };
const decided = { current: { route: 'codex', reason: '需要强执行' }, difficulty: { level: 'high' } };

test('普通形态：报告路由、理由、难度、模式', () => {
  const line = renderRouteLine({ state: decided, cfg });
  assert.match(line, /本轮：codex（需要强执行）/);
  assert.match(line, /难度 high/);
  assert.match(line, /会派发/);
});

test('observe 模式：显示仅观察', () => {
  const line = renderRouteLine({ state: decided, cfg: { auto: { ...cfg.auto, mode: 'observe' } } });
  assert.match(line, /仅观察/);
});

test('让出形态：明确要求主代理不要自己做，并给出接手条件', () => {
  const state = {
    ...decided,
    yielded: { at: 1_000_000, provider: 'native-codex', partLabel: '3 份并行', targets: ['a.js', 'b.js'] },
  };
  const line = renderRouteLine({ state, cfg, now: 1_000_000 + 60_000 });
  assert.match(line, /已交给 native-codex（3 份并行），负责 a\.js、b\.js/);
  assert.match(line, /不要自己执行同一件事/);
  assert.match(line, /若通知报告失败或中断，再自己接手/);
});

test('让出形态：接力标注两段', () => {
  const state = { ...decided, yielded: { at: 0, provider: 'claude → codex', partLabel: '接力', relay: true } };
  const line = renderRouteLine({ state, cfg, now: 1000 });
  assert.match(line, /方案→执行两段/);
});

test('让出超时后回退到普通形态（避免永久等待）', () => {
  const state = { ...decided, yielded: { at: 0, provider: 'native-codex' } };
  const line = renderRouteLine({ state, cfg, now: 21 * 60 * 1000 });
  assert.match(line, /本轮：codex/);
  assert.doesNotMatch(line, /不要自己执行同一件事/);
});

test('关闭 yield 时不出现让出指令', () => {
  const state = { ...decided, yielded: { at: 0, provider: 'native-codex' } };
  const line = renderRouteLine({ state, cfg: { auto: { ...cfg.auto, yield: false } }, now: 1000 });
  assert.doesNotMatch(line, /不要自己执行同一件事/);
});

test('没有判定结果时返回空串', () => {
  assert.equal(renderRouteLine({ state: {}, cfg }), '');
  assert.equal(renderRouteLine({}), '');
});
