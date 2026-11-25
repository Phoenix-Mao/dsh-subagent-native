import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPlan, relayHandoffLine, shouldRelay } from '../lib/relay.js';

const relay = { enabled: true, planChannel: 'claude', executeChannel: 'codex', minDifficulty: 'high' };

test('shouldRelay：未启用或路由不匹配时不接力', () => {
  assert.equal(shouldRelay({ relay: { ...relay, enabled: false }, route: 'claude', level: 'high' }), false);
  assert.equal(shouldRelay({ relay, route: 'codex', level: 'high' }), false);
  assert.equal(shouldRelay({ relay, route: 'self', level: 'high' }), false);
  assert.equal(shouldRelay({}), false);
});

test('shouldRelay：难度达到门槛才接力', () => {
  assert.equal(shouldRelay({ relay, route: 'claude', level: 'low' }), false);
  assert.equal(shouldRelay({ relay, route: 'claude', level: 'medium' }), false);
  assert.equal(shouldRelay({ relay, route: 'claude', level: 'high' }), true);
  assert.equal(shouldRelay({ relay, route: 'claude', level: 'extreme' }), true);
  // 门槛可调
  assert.equal(shouldRelay({ relay: { ...relay, minDifficulty: 'medium' }, route: 'claude', level: 'medium' }), true);
});

test('shouldRelay：执行方关闭时不接力，省略开关时保持兼容', () => {
  const input = { relay, route: 'claude', level: 'high' };
  assert.equal(shouldRelay({ ...input, execEnabled: false }), false);
  assert.equal(shouldRelay(input), true);
});

test('extractPlan：拼接文本块，忽略非文本', () => {
  const plan = extractPlan({
    output: [
      { type: 'text', text: '先改 A.cs' },
      { type: 'image', url: 'x' },
      { type: 'text', text: '再改 B.cs' },
    ],
  });
  assert.equal(plan, '先改 A.cs\n再改 B.cs');
  assert.equal(extractPlan(null), '');
  assert.equal(extractPlan({ output: 'not-an-array' }), '');
});

test('relayHandoffLine：摘要与空方案兜底', () => {
  assert.match(relayHandoffLine('abc'), /上游方案共 3 字/);
  assert.match(relayHandoffLine('x'.repeat(500)), /…$/);
  assert.match(relayHandoffLine(''), /上游方案为空/);
});
