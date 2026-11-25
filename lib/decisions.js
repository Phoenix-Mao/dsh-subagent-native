/**
 * 判定日志：每次路由判定/派发/让出都落一行，供事后分析（这是判断「兜底触发值不值」的主要证据）。
 *
 * 和展示历史一样要能扛住长期运行：重启后从文件读回最近若干条，文件超限时原子压缩。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createDecisionLog(options = {}) {
  const file = options.file;
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes) || 1024 * 1024);
  const keep = Math.max(20, Number(options.keep) || 200);
  if (!file) throw new Error('decision log 需要 file');

  const readRaw = () => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  };

  const parse = (text) => {
    const rows = [];
    for (const line of String(text ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object') rows.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows;
  };

  const load = (limit = 100) => {
    try {
      return parse(readRaw()).slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  };

  const compact = () => {
    let rows;
    try {
      rows = parse(readRaw()).slice(-keep);
    } catch {
      return false;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 忽略 */
      }
      return false;
    }
  };

  const append = (record) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      if (fs.statSync(file).size > maxBytes) compact();
    } catch {
      /* 写失败不影响主流程 */
    }
  };

  const clear = () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
  };

  return { file, load, append, compact, clear };
}
