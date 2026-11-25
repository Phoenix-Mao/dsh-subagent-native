/**
 * 调用历史（详细版）：每次子代理运行落一行 JSONL。
 *
 * 记录范围刻意做宽，因为这份日志是后续判断「兜底触发该不该继续」的唯一证据：
 *   - 时间：开始/结束/耗时
 *   - 通道：provider / model / effort / permissionMode / cwd
 *   - 触发来源：model（模型调工具）还是 framework（插件兜底触发）
 *   - 内容：提示长度与前 200 字、答复长度与前 200 字
 *   - 用量：input / cached / cacheWrite / output / reasoning
 *   - 结果：stopReason / exitCode / 事件数 / 诊断 / stderr 尾部
 *   - 成本估算：codex 按中转站 1 折价估算（claude 的渠道价未知，标 unknown）
 *
 * 真实账单仍以中转站控制台为准；这里的成本只是估算，用于横向比较。
 */
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_CHARS = 200;
const STDERR_CHARS = 500;

/**
 * 内置价目表（每百万 token，2026-11 某中转站控制台实价）。
 *
 * ⚠️ 这是**某个渠道**的价格，不是公开价。换中转站必须用 `config.pricing` 覆盖，
 * 否则成本估算与预算护栏都会偏——估算错了，护栏就等于没有。
 *
 * `inputIncludesCached` 是**通道口径**而非价格：codex 的 `input_tokens` 含缓存命中，
 * claude 的不含。它随通道走，不随价格走，所以和价格一起放在这里但可单独覆盖。
 */
export const DEFAULT_PRICING = {
  // codex 走 Codex 通道：1 折
  'codex-1zhe': {
    input: 0.2,
    output: 1.0,
    cacheWrite: 0.25,
    cacheRead: 0.01,
    inputIncludesCached: true,
    cacheWrite1hFactor: 1.6,
  },
  // claude 走 Claude Code 通道：4 折（API 价是 9.5 折）
  'claude-4zhe': {
    input: 1.6,
    output: 8.0,
    cacheWrite: 2.0,
    cacheRead: 0.08,
    inputIncludesCached: false,
    cacheWrite1hFactor: 1.6,
  },
};

/** 可被用户覆盖的价格字段。 */
export const PRICING_FIELDS = Object.freeze(['input', 'output', 'cacheWrite', 'cacheRead']);

const BASIS_BY_CHANNEL = { codex: 'codex-1zhe', claude: 'claude-4zhe' };

export function basisForChannel(channel) {
  return BASIS_BY_CHANNEL[channel] ?? 'unknown';
}

/**
 * 把用户覆盖合并到内置价目上。
 *
 * 只接受非负数值，非法字段静默忽略——一个手滑的字符串不该让插件起不来。
 * 有任何字段被覆盖就打 `custom: true`，记录里据此标注「非内置价」。
 */
export function mergePricing(base, override) {
  if (!base) return null;
  if (!override || typeof override !== 'object') return base;
  const merged = { ...base };
  let touched = false;
  for (const field of PRICING_FIELDS) {
    const value = Number(override[field]);
    if (Number.isFinite(value) && value >= 0) {
      merged[field] = value;
      touched = true;
    }
  }
  const factor = Number(override.cacheWrite1hFactor);
  if (Number.isFinite(factor) && factor > 0) {
    merged.cacheWrite1hFactor = factor;
    touched = true;
  }
  if (typeof override.inputIncludesCached === 'boolean') {
    merged.inputIncludesCached = override.inputIncludesCached;
    touched = true;
  }
  if (touched) merged.custom = true;
  return merged;
}

/** 通道 → 实际生效价目（用户覆盖优先，其次内置）。未知通道返回 null。 */
export function pricingForChannel(channel, pricingConfig) {
  const base = DEFAULT_PRICING[basisForChannel(channel)] ?? null;
  if (!base) return null;
  const override = pricingConfig && typeof pricingConfig === 'object' ? pricingConfig[channel] : null;
  return mergePricing(base, override);
}

/** 价目是否来自用户覆盖（用于在记录与 UI 上标注）。 */
export function isCustomPricing(pricing) {
  return Boolean(pricing && pricing.custom === true);
}

export function preview(text, limit = PREVIEW_CHARS) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * 成本估算。
 *
 * 第二个参数可以是价目对象（自定义价），也可以是内置 basis 名（兼容旧调用/测试）。
 *
 * 口径差异（2026-11-25 用中转站账单 + codex 原始事件核对过）：
 *   codex 的 `input_tokens` **包含** `cached_input_tokens`，中转站按 `input - cached` 计普通输入价，
 *   再单独按缓存价计 cached；直接拿 input 全额计价会高估（实测 18%，缓存占比高时可达 2.4 倍）。
 *   claude 的 `input_tokens` 本来就不含 `cache_read_input_tokens`，不需要减。
 */
export function estimateCost(usage, basisOrPrice) {
  const price =
    typeof basisOrPrice === 'string'
      ? (DEFAULT_PRICING[basisOrPrice] ?? null)
      : (basisOrPrice && typeof basisOrPrice === 'object' ? basisOrPrice : null);
  if (!usage || !price || typeof price.input !== 'number') return null;
  const rawInput = usage.input ?? 0;
  const cached = usage.cached ?? 0;
  const billableInput = price.inputIncludesCached === true ? Math.max(0, rawInput - cached) : rawInput;
  // 1 小时缓存写价 = 5 分钟的 1.6 倍（$2.00 → $3.20）；系数可被自定义价覆盖
  const factor = Number(price.cacheWrite1hFactor) > 0 ? Number(price.cacheWrite1hFactor) : 1.6;
  const cacheWrite1h = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite ?? 0);
  const cacheWrite5m = Math.max(0, (usage.cacheWrite ?? 0) - cacheWrite1h);
  const usd =
    (billableInput * price.input +
      (usage.output ?? 0) * price.output +
      cacheWrite5m * price.cacheWrite +
      cacheWrite1h * price.cacheWrite * factor +
      cached * price.cacheRead) /
    1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export function buildRecord(input) {
  const {
    id,
    startedAt,
    endedAt,
    channel,
    provider,
    model,
    effort,
    permissionMode,
    cwd,
    trigger,
    fanout,
    relay,
    git,
    parentSession,
    prompt,
    answer,
    usage,
    stopReason,
    exitCode,
    eventCount,
    problems,
    stderrTail,
    // 实际生效价目（已按通道解析好的对象）。不传则用内置价目。
    pricing,
  } = input;

  const basis = basisForChannel(channel);
  const price = pricing && typeof pricing === 'object' ? pricing : (DEFAULT_PRICING[basis] ?? null);
  return {
    id,
    startedAt,
    endedAt,
    durationMs: Math.max(0, (endedAt ?? Date.now()) - (startedAt ?? Date.now())),
    channel,
    provider,
    model: model || null,
    effort: effort || null,
    permissionMode: permissionMode || null,
    cwd: cwd || null,
    trigger: trigger || 'model',
    fanout: fanout ? { index: fanout.index, total: fanout.total } : null,
    relay: relay ?? null,
    git: git
      ? {
          changedFiles: Array.isArray(git.changedFiles) ? git.changedFiles.slice(0, 50) : [],
          untrackedAdded: Array.isArray(git.untrackedAdded) ? git.untrackedAdded.slice(0, 50) : [],
          stat: String(git.stat ?? '').slice(0, 1200),
        }
      : null,
    parentSession: parentSession ? String(parentSession).slice(-8) : null,
    promptChars: String(prompt ?? '').length,
    promptPreview: preview(prompt),
    answerChars: String(answer ?? '').length,
    answerPreview: preview(answer),
    usage: usage ?? null,
    costEstimate: {
      basis,
      usd: estimateCost(usage, price),
      ...(isCustomPricing(price) ? { custom: true } : {}),
    },
    stopReason: stopReason ?? 'unknown',
    exitCode: exitCode ?? null,
    eventCount: eventCount ?? 0,
    problems: Array.isArray(problems) ? problems.slice(0, 10) : [],
    stderrTail: String(stderrTail ?? '').slice(-STDERR_CHARS) || null,
  };
}

/**
 * 没有 usage 的运行（被取消 / 超时 / 进程异常退出）成本记 0 会系统性地低估——
 * 而这类运行往往正是最贵的（跑得久才被掐）。用同通道最近几次已结算成本的中位数回填。
 */
const round6 = (value) => Math.round(value * 1e6) / 1e6;

function quantileOf(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

/** 已结算运行的「每毫秒成本」样本（按通道）。 */
function costRates(runs, channel) {
  const rates = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || run.channel !== channel) continue;
    const usd = run.costEstimate?.usd;
    const ms = run.durationMs;
    if (typeof usd !== 'number' || usd <= 0) continue;
    if (typeof ms !== 'number' || ms < 1000) continue;
    rates.push(usd / ms);
  }
  return rates.sort((a, b) => a - b);
}

/**
 * 失败运行的保守估算：按「同通道每秒成本中位数 × 本次耗时」外推。
 *
 * 以前用「最近几次成本的中位数」直接回填，对超时这类长运行会低估 6–80 倍——
 * 而它们恰恰是最贵的失败。按时长缩放后，跑多久就按多久计费。
 */
export function estimateFailedCost(runs, channel, durationMs, options = {}) {
  const rates = costRates(runs, channel);
  if (rates.length === 0) return null;
  const mid = quantileOf(rates, 0.5);
  const high = quantileOf(rates, 0.9);
  const ms = Math.max(1000, Number(durationMs) || 0);
  const capMs = Number(options.capMs) > ms ? Number(options.capMs) : ms;
  const usd = Math.min(mid * ms, high * capMs);
  return round6(usd);
}

/** 事前预估：同通道已结算成本的 p75（用于预算闸门预占，避免并发放行）。 */
export function projectCost(runs, channel, q = 0.75) {
  const costs = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.channel === channel)
    .map((run) => run.costEstimate?.usd)
    .filter((usd) => typeof usd === 'number' && usd > 0)
    .sort((a, b) => a - b);
  if (costs.length === 0) return null;
  return round6(quantileOf(costs, q));
}

/** 同通道最近若干次成本的中位数（保留给需要粗估的场景）。 */
export function medianCost(runs, channel, lookback = 5) {
  const costs = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.channel === channel && typeof run.costEstimate?.usd === 'number' && run.costEstimate.usd > 0)
    .slice(-Math.max(1, lookback))
    .map((run) => run.costEstimate.usd)
    .sort((a, b) => a - b);
  if (costs.length === 0) return null;
  return round6(quantileOf(costs, 0.5));
}

export function createHistoryStore(options = {}) {
  const file = options.file;
  const limit = Math.max(1, Number(options.limit) || 1000);
  const compactBytes = Math.max(64 * 1024, Number(options.compactBytes) || 2 * 1024 * 1024);
  if (!file) throw new Error('history store 需要 file');

  /** 读原始文本；文件不存在算空，其他错误抛出去（供压缩区分「读失败」与「空历史」）。 */
  const readRaw = () => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  };

  const parseRows = (text) => {
    const rows = [];
    for (const line of String(text ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object' && row.id) rows.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows;
  };

  const load = () => {
    try {
      return parseRows(readRaw()).slice(-limit);
    } catch {
      return [];
    }
  };

  /** 原子压缩：先写临时文件再 rename；读失败直接放弃（绝不把空数组写回去）。 */
  const compact = () => {
    let rows;
    try {
      rows = parseRows(readRaw()).slice(-limit);
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
      if (fs.statSync(file).size > compactBytes) compact();
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

  return { file, load, append, clear, compact };
}

export function summarize(runs, now = Date.now()) {
  const list = Array.isArray(runs) ? runs : [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayStart = start.getTime();
  const today = list.filter((run) => (run.startedAt ?? 0) >= todayStart);

  const byChannel = {};
  const byTrigger = {};
  for (const run of today) {
    byChannel[run.channel ?? 'unknown'] = (byChannel[run.channel ?? 'unknown'] ?? 0) + 1;
    byTrigger[run.trigger ?? 'unknown'] = (byTrigger[run.trigger ?? 'unknown'] ?? 0) + 1;
  }

  const durations = today.map((run) => run.durationMs).filter((value) => typeof value === 'number' && value > 0);
  const tokens = today.reduce(
    (sum, run) => ({
      input: sum.input + (run.usage?.input ?? 0),
      cached: sum.cached + (run.usage?.cached ?? 0),
      output: sum.output + (run.usage?.output ?? 0),
    }),
    { input: 0, cached: 0, output: 0 },
  );
  const cost = today.reduce((sum, run) => sum + (run.costEstimate?.usd ?? 0), 0);

  return {
    total: list.length,
    today: today.length,
    byChannel,
    byTrigger,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    tokens,
    estimatedCostUsd: Math.round(cost * 1e6) / 1e6,
    failures: today.filter((run) => run.stopReason && run.stopReason !== 'completed').length,
  };
}
