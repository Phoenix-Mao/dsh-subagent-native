import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../lib/ledger.js';
import { checkBudget } from '../lib/budget.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-native-ledger-'));
  return path.join(dir, 'ledger.jsonl');
}

const now = new Date('2026-11-25T12:00:00').getTime();
const today = new Date('2026-11-25T09:00:00').getTime();
const yesterday = new Date('2026-11-24T23:59:00').getTime();

test('ledger：追加后按天聚合，跨零点不计入今天', () => {
  const ledger = createLedger({ file: tempFile(), now: () => now });
  ledger.add({ at: today, channel: 'codex', usd: 0.01 });
  ledger.add({ at: today + 1000, channel: 'claude', usd: 0.05 });
  ledger.add({ at: yesterday, channel: 'codex', usd: 9 });
  assert.equal(ledger.today(now), 0.06);
  assert.equal(ledger.size(), 3);
});

test('ledger：重新打开后从文件恢复（重启不掉账）', () => {
  const file = tempFile();
  createLedger({ file, now: () => now }).add({ at: today, channel: 'codex', usd: 0.07 });
  const reopened = createLedger({ file, now: () => now });
  assert.equal(reopened.today(now), 0.07);
});

test('ledger：非法记录被跳过', () => {
  const file = tempFile();
  fs.writeFileSync(file, ['not json', JSON.stringify({ at: today, usd: 0.02 }), JSON.stringify({ usd: 5 })].join('\n'), 'utf8');
  const ledger = createLedger({ file, now: () => now });
  assert.equal(ledger.size(), 1);
  assert.equal(ledger.today(now), 0.02);
});

test('ledger：首次启动用历史补种，已有账目不重复补', () => {
  const file = tempFile();
  const ledger = createLedger({ file, now: () => now });
  const seeded = ledger.seedFromHistory([
    { startedAt: today, channel: 'codex', costEstimate: { usd: 0.03 } },
    { startedAt: today, channel: 'codex', costEstimate: { usd: null } },
  ]);
  assert.equal(seeded, 1);
  assert.equal(ledger.today(now), 0.03);
  assert.equal(ledger.seedFromHistory([{ startedAt: today, costEstimate: { usd: 1 } }]), 0);
});

test('checkBudget：优先用账本口径的 spent', () => {
  const gate = checkBudget({ spent: 0.5, budget: { enabled: true, dailyUsd: 0.4 }, now });
  assert.equal(gate.ok, false);
  assert.equal(gate.spent, 0.5);
  const open = checkBudget({ spent: 0.1, budget: { enabled: true, dailyUsd: 0.4 }, now });
  assert.equal(open.ok, true);
  assert.equal(open.remaining, 0.3);
});

test('账本口径不受历史清空/裁剪影响（回归）', () => {
  const ledger = createLedger({ file: tempFile(), now: () => now });
  ledger.add({ at: today, channel: 'codex', usd: 0.2 });
  // 历史被清空 → runs 为空，但账本仍然记得
  const gate = checkBudget({ runs: [], spent: ledger.today(now), budget: { enabled: true, dailyUsd: 0.15 }, now });
  assert.equal(gate.ok, false, '清空历史不应让预算复位');
  assert.equal(gate.spent, 0.2);
});
