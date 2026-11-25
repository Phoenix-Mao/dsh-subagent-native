/**
 * 并行扇出：把一个任务按「目标」拆成 N 个子任务。
 *
 * 只做**确定性拆分**——从提示里抽文件路径，按路径分组；同一文件绝不拆到两组。
 * 抽不到 ≥2 个目标就不扇出，退回单发。不做语义拆分（那需要模型，成本和不确定性都更高）。
 */

// 绝对路径或带扩展名的相对路径（与 difficulty.js 的口径一致）
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s"'<>|，。；、`]+)|(?:(?<=^|[\s（(`"'「」【】、，。；：])[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,8})/g;

const MAX_TARGETS = 12;

/** 去重键：Windows 下 `src/a.js` 和 `src\a.js` 是同一个文件，不能拆到两份里。 */
function normalizeKey(value) {
  return String(value)
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** 抽出提示里提到的目标（去重、保持出现顺序）。 */
export function extractTargets(prompt) {
  const text = String(prompt ?? '');
  const seen = new Set();
  const targets = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const value = match[0].replace(/[，。；、）)]+$/, '');
    const key = normalizeKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(value);
    if (targets.length >= MAX_TARGETS) break;
  }
  return targets;
}

/**
 * @param {string} prompt
 * @param {{ maxParts?: number, minTargets?: number }} [options]
 * @returns {{ targets: string[], parts: Array<{ index: number, total: number, targets: string[] }> } | null}
 */
export function splitTargets(prompt, options = {}) {
  // maxParts <= 1 表示「不扇出」，不要向下取整到 2
  const raw = Number(options.maxParts);
  const maxParts = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 3;
  if (maxParts <= 1) return null;
  const minTargets = Math.max(2, Number(options.minTargets) || 2);
  const targets = extractTargets(prompt);
  if (targets.length < minTargets) return null;

  const total = Math.min(maxParts, targets.length);
  const size = Math.ceil(targets.length / total);
  const parts = [];
  for (let i = 0; i < targets.length; i += size) {
    parts.push({ index: parts.length + 1, total: 0, targets: targets.slice(i, i + size) });
  }
  const finalTotal = parts.length;
  for (const part of parts) part.total = finalTotal;
  return { targets, parts };
}

/** 给简报用的目标清单文本。 */
export function describePart(part) {
  const list = part.targets.join('、');
  return `第 ${part.index}/${part.total} 份：${list}`;
}
