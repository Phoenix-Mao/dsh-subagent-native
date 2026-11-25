/**
 * 预算账本：只记「今天花了多少」，与展示用的历史完全分开。
 *
 * 为什么必须独立：之前的预算直接读 runs，于是
 *   - 关掉 history.enabled → runs 不再增长 → 预算永远放行；
 *   - history.limit 变小 → 当天的旧支出被挤掉 → 预算回退；
 *   - 点「清空记录」→ 预算立刻归零。
 * 账本只追加、只按天聚合，清历史不影响它。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createLedger(options = {}) {
  const file = options.file;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  if (!file) throw new Error('ledger 需要 file');

  let entries = loadFile();

  function loadFile() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const rows = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          if (row && typeof row === 'object' && Number.isFinite(row.at)) rows.push(row);
        } catch {
          /* 坏行跳过 */
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  const append = (entry) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* 写失败不影响主流程 */
    }
  };

  return {
    file,

    /** 记一笔已结算支出（估算值也算）。 */
    add(entry) {
      const row = {
        at: Number(entry?.at) || now(),
        channel: entry?.channel ?? null,
        usd: Number(entry?.usd) > 0 ? Number(entry.usd) : 0,
        estimated: entry?.estimated === true,
      };
      entries.push(row);
      append(row);
      return row;
    },

    /** 今天（本地零点起）累计支出。 */
    today(nowMs = now()) {
      const start = new Date(nowMs);
      start.setHours(0, 0, 0, 0);
      const from = start.getTime();
      let sum = 0;
      for (const row of entries) if (row.at >= from) sum += row.usd ?? 0;
      return Math.round(sum * 1e6) / 1e6;
    },

    /** 首次启动时用历史记录补种，避免升级后当天额度被重置。 */
    seedFromHistory(runs) {
      if (entries.length > 0) return 0;
      let added = 0;
      for (const run of Array.isArray(runs) ? runs : []) {
        const usd = run?.costEstimate?.usd;
        if (typeof usd !== 'number' || usd <= 0) continue;
        const row = {
          at: Number(run.endedAt ?? run.startedAt) || now(),
          channel: run.channel ?? null,
          usd,
          estimated: true,
        };
        entries.push(row);
        append(row);
        added += 1;
      }
      return added;
    },

    size() {
      return entries.length;
    },
  };
}
