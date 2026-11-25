/**
 * 简报生成：确定性，不调模型。
 *
 * CLI 看不见会话上下文，简报是它唯一的信息来源；实测同一条 codex 通道：
 * 简报含糊的一次派发（46 万 token）真实成本约 $0.039，简报精确的 3 份并行合计约 $0.025——
 * 差距约 1.6 倍，且含糊那次还多花了 3 倍墙钟时间。
 *
 * 原则「给足信息 + 明确边界」：目标用原文、禁止无目的遍历、列出本会话碰过的文件、带上失败证据、超规模就停。
 *
 * **分段额度**：以前先拼整篇再从尾部截断，方案一长就会把「边界 / 文件 / 验收 / 输出」整段切掉——
 * 而那几段恰恰是防止乱探索的部分。现在改成：固定段先占位，剩余额度按权重分给可伸缩段（方案 → 目标 → 证据）。
 */

export const DEFAULT_CONSTRAINTS = Object.freeze([
  '只处理与目标直接相关的文件；不要遍历整个仓库、不要做与目标无关的探索',
  '信息不足时按最保守解释执行，并在结论里列出你的假设',
  '如果发现任务规模明显超出预期，停止执行，只给方案与风险',
  '不提交 git、不安装全局依赖、不修改用户配置',
]);

export const PLANNER_CONSTRAINTS = Object.freeze([
  '这一轮**只出方案，不写代码、不改文件**',
  '只处理与目标直接相关的文件；不要遍历整个仓库',
  '信息不足时按最保守解释给出方案，并列出你的假设',
  '方案要能让另一个执行代理直接照做：具体到文件、函数/行号、步骤顺序',
]);

export function truncate(text, max) {
  const value = String(text ?? '');
  if (!(max > 0) || value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`;
}

function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 截到 max 以内并留截断标记（标记本身也算长度）。 */
function fitSection(text, max) {
  const value = String(text ?? '');
  if (!(max > 0) || value.length <= max) return value;
  const marker = `…（已截断，原长 ${value.length} 字符）`;
  if (max <= marker.length + 8) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - marker.length - 1)}\n${marker}`;
}

const sectionLen = (part) => (part.heading ? part.heading.length + 1 : 0) + part.body.length + 1;

/**
 * @param {{
 *   prompt: string, cwd: string, cliId?: string, model?: string,
 *   files?: Array<{path: string, note?: string}>,
 *   failures?: Array<{tool?: string, target?: string, firstLine?: string}>,
 *   targets?: string[], part?: {index: number, total: number} | null,
 *   role?: 'executor' | 'planner', plan?: string,
 *   constraints?: readonly string[], acceptance?: string,
 *   maxChars?: number, maxFiles?: number,
 * }} input
 */
export function buildBrief(input = {}) {
  const {
    prompt = '',
    cwd = '',
    cliId = '',
    model = '',
    files = [],
    failures = [],
    targets = [],
    part = null,
    role = 'executor',
    plan = '',
    constraints,
    acceptance = '',
    maxChars = 8000,
    maxFiles = 8,
  } = input;

  const who = [cliId, model].filter(Boolean).join(' / ') || '外部执行代理';
  const isPlanner = role === 'planner';

  // ── 固定段（永不压缩，除非固定段本身就超预算） ─────────────────────
  const targetList = (Array.isArray(targets) ? targets : []).filter(Boolean);
  const fileList = (Array.isArray(files) ? files : []).filter((file) => file && file.path).slice(0, Math.max(0, maxFiles));
  const failureLines = (Array.isArray(failures) ? failures : [])
    .filter((item) => item && (item.tool || item.firstLine || item.target))
    .slice(0, 3)
    .map((item) => {
      const head = [item.tool, item.target ? oneLine(item.target, 100) : ''].filter(Boolean).join(' ');
      return `- ${head || '失败'}：${oneLine(item.firstLine ?? '', 240) || '（无输出）'}`;
    });

  const prefix = isPlanner
    ? `你是被 DSH 外包出去的**方案设计者**（${who}）。一次性任务，无法向调用方追问；你的方案会交给另一个执行代理去做。`
    : `你是被 DSH 外包出去的执行代理（${who}）。一次性任务，无法向调用方追问。`;

  /** @type {Array<{key:string, heading:string, body:string, elastic:boolean, weight:number}>} */
  const parts = [];
  const push = (key, heading, body, elastic = false, weight = 0) => {
    parts.push({ key, heading, body: String(body ?? ''), elastic, weight });
  };

  push('prompt', '## 目标', String(prompt).trim() || '（调用方未提供目标描述）', true, 0.35);
  push('cwd', '## 工作目录', `${cwd || '（未提供）'}（只在此目录内操作；命令按当前平台的 shell 语法写）`);
  if (targetList.length > 0) {
    const lines = [];
    if (part) lines.push(`这是并行拆分中的第 ${part.index}/${part.total} 份，其他份由别的执行代理同时处理。`);
    for (const target of targetList) lines.push(`- ${target}`);
    push('targets', '## 你负责的目标（只处理这些，别碰其他份）', lines.join('\n'));
  }
  push(
    'boundary',
    '## 边界',
    (isPlanner ? PLANNER_CONSTRAINTS : constraints ?? DEFAULT_CONSTRAINTS).map((item) => `- ${item}`).join('\n'),
  );
  if (String(plan ?? '').trim()) {
    push('plan', '## 上游方案（由方案设计代理给出，照它实现）\n\n如果方案有明显问题，按你的判断修正，并在结论里说明偏离了哪一条、为什么。', String(plan).trim(), true, 0.5);
  }
  if (fileList.length > 0) {
    push(
      'files',
      '## 本会话最近碰过的文件（优先从这里找，不要全仓库搜）',
      fileList.map((file) => `- ${file.path}${file.note ? `（${oneLine(file.note, 100)}）` : ''}`).join('\n'),
    );
  }
  if (failureLines.length > 0) {
    push('evidence', '## 最近的失败证据（别重复踩）', failureLines.join('\n'), true, 0.15);
  }
  if (!isPlanner) {
    push(
      'acceptance',
      '## 验收',
      acceptance || '跑与改动直接相关的构建/测试，并在结论里给出实际执行的命令与结果；没有测试就说明你如何自检',
    );
  }
  push(
    'output',
    '## 输出',
    isPlanner
      ? '结论 / 改动清单（文件 + 函数/行号 + 具体改法）/ 实施步骤顺序 / 风险与回滚点'
      : '结论 / 改动文件与行号 / 已运行命令与结果 / 风险与未完成项',
  );
  push('closing', '', '（目标不清或信息不足时，先给判断和假设，不要靠大范围探索来猜。）');

  // ── 额度分配 ───────────────────────────────────────────────────────
  // 固定段先占满，剩余额度按权重分给可伸缩段；这样方案再长也不会挤掉边界与验收。
  const overhead = prefix.length + 2;
  const fixedLen = parts.filter((p) => !p.elastic).reduce((sum, p) => sum + sectionLen(p), 0);
  const elastic = parts.filter((p) => p.elastic);
  let budget = Math.max(0, maxChars - overhead - fixedLen);

  if (elastic.length > 0 && budget > 0) {
    const totalWeight = elastic.reduce((sum, p) => sum + p.weight, 0) || 1;
    for (const item of elastic) {
      const share = Math.floor((budget * item.weight) / totalWeight);
      // 极小的额度不值得开口，直接把该段缩到最短
      item.body = fitSection(item.body, Math.max(24, share));
    }
  } else {
    for (const item of elastic) item.body = fitSection(item.body, 0);
  }

  // 固定段本身超预算时的兜底：按比例压缩它们（正常配置不会走到）
  let assembled = [prefix, '', ...parts.flatMap((p) => (p.heading ? [p.heading, p.body, ''] : [p.body]))].join('\n');
  if (assembled.length > maxChars) {
    const fixedParts = parts.filter((p) => !p.elastic && p.body.length > 80);
    const over = assembled.length - maxChars;
    const perPart = Math.ceil(over / Math.max(1, fixedParts.length)) + 40;
    for (const item of fixedParts) item.body = fitSection(item.body, Math.max(40, item.body.length - perPart));
    assembled = [prefix, '', ...parts.flatMap((p) => (p.heading ? [p.heading, p.body, ''] : [p.body]))].join('\n');
  }

  return truncate(assembled, maxChars);
}
