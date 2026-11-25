/**
 * 任务难度评估：**确定性**打分，毫秒级、零 token。
 *
 * 为什么需要它：`auto-delegate` 是框架驱动、不注册工具，没有主代理来填
 * `task_difficulty`（maestro 是模型自己评估后传参）。所以难度只能由插件算，
 * 再用「每个 CLI 一个最低难度门槛」决定值不值得惊动上级。
 *
 * 口径（与 maestro 一致）：claude / codex 是两个**平级**上级，各自处理擅长的活；
 * 难度不够就自己干，**不互相降级**。
 */

export const LEVELS = Object.freeze(['low', 'medium', 'high', 'extreme']);

/** 各档起始分。门槛判断用分数比较，避免档位边界来回跳。 */
export const LEVEL_FLOOR = Object.freeze({ low: 0, medium: 10, high: 20, extreme: 35 });

/** 规则命中时的典型分：用于判断「离门槛有多近」，决定要不要请 judge 复核。 */
export const LEVEL_MAX = Object.freeze({ low: 9, medium: 19, high: 34, extreme: 50 });

// 强规模词：单独出现就足以把任务推到 medium（重构/迁移这类活，一句话也可能很大）
const STRONG_SCALE_WORDS = Object.freeze([
  '重构', '迁移', '架构', '跨模块', '多个模块', '批量', '全部', '所有', '逐个', '全量', '整体',
]);
const REASON_WORDS = Object.freeze(['为什么', '根因', '权衡', '方案', '评审', '设计', '取舍']);
const EXEC_WORDS = Object.freeze(['复现', '编译', '报错', '测试', '异常', '崩溃', '反汇编', '修', '改', '加']);

// 绝对路径（D:\a\b.cs / D:/a/b.cs）或带扩展名的相对路径（src/index.js），
// 允许前面是空白、括号、引号、反引号、中文标点（2026-11-19 修：反引号里的路径原先认不出）
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s"'<>|，。；、`]+)|(?:(?<=^|[\s（(`"'「」【】、，。；：])[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,8})/g;

// 否定句：把「不要/别/无需…」后面紧跟的一小段抹掉，避免「不要重构，只改一行」被算成大活
const NEGATION = /(?:不要|不用|不需要|无需|不必|别|禁止|避免)([^，。；\n]{0,14})/g;

// 中文没有词边界，几个词会被更长的词误命中（「所有权」里的「所有」）
const WORD_EXCLUSIONS = Object.freeze({
  所有: ['权', '者', '制'],
  全部: ['地'],
});

function stripNegated(text) {
  return String(text ?? '').replace(NEGATION, (whole, tail) => whole.slice(0, 2) + '□'.repeat(tail.length));
}

/** 词命中，但排除已知的误命中组合。 */
export function hitsWord(text, word) {
  const source = String(text ?? '');
  let from = 0;
  for (;;) {
    const at = source.indexOf(word, from);
    if (at < 0) return false;
    const next = source.slice(at + word.length, at + word.length + 1);
    const excluded = (WORD_EXCLUSIONS[word] ?? []).includes(next);
    if (!excluded) return true;
    from = at + word.length;
  }
}

export function levelOfScore(score) {
  const value = Number(score) || 0;
  if (value >= LEVEL_FLOOR.extreme) return 'extreme';
  if (value >= LEVEL_FLOOR.high) return 'high';
  if (value >= LEVEL_FLOOR.medium) return 'medium';
  return 'low';
}

export function levelIndex(level) {
  return LEVELS.indexOf(level);
}

/** 提示里出现多少个像路径的东西（粗算，够用即可）。 */
export function countPaths(text) {
  const matches = String(text ?? '').match(PATH_PATTERN);
  return matches ? matches.length : 0;
}

/**
 * @param {{ prompt?: string, cwd?: string, failures?: number, fileCount?: number }} input
 * @returns {{ level: string, score: number, signals: string[] }}
 */
export function estimateDifficulty(input = {}) {
  const prompt = String(input.prompt ?? '');
  // 打分用「去掉否定从句」的文本：否定句里的动词不该加分
  const scored = stripNegated(prompt);
  const signals = [];
  let score = 0;

  if (prompt.length >= 80) {
    score += 2;
    signals.push('提示≥80字');
  }
  if (prompt.length >= 300) {
    score += 3;
    signals.push('提示≥300字');
  }
  if (prompt.length >= 800) {
    score += 3;
    signals.push('提示≥800字');
  }

  // 强规模词：命中即 +10（直达 medium），多个再累加，最多 +14。
  // 这条是 2026-11-19 验收 T2 逼出来的：「重构 517 的通信层」原本只算 5 分，
  // 被 claude 的 medium 门槛挡掉，等于把最该外包的活留下了。
  const strongHits = STRONG_SCALE_WORDS.filter((word) => hitsWord(scored, word));
  if (strongHits.length > 0) {
    score += Math.min(14, 8 + strongHits.length * 2);
    signals.push(`强规模词：${strongHits.join('/')}`);
  }

  const reasonHits = REASON_WORDS.filter((word) => hitsWord(scored, word));
  if (reasonHits.length > 0) {
    score += Math.min(6, reasonHits.length * 2 + 2);
    signals.push(`推理词：${reasonHits.join('/')}`);
  }

  const execHits = EXEC_WORDS.filter((word) => hitsWord(scored, word));
  if (execHits.length > 0) {
    score += Math.min(6, execHits.length * 2 + 1);
    signals.push(`执行词：${execHits.join('/')}`);
  }

  const paths = Math.max(Number(input.fileCount) || 0, countPaths(prompt));
  if (paths >= 3) {
    score += 3;
    signals.push(`涉及路径≥3（${paths}）`);
  }

  const failures = Number(input.failures) || 0;
  if (failures > 0) {
    score += 2;
    signals.push(`有失败证据（${failures}）`);
  }

  const bounded = Math.max(0, Math.min(50, score));
  return { level: levelOfScore(bounded), score: bounded, signals };
}

/**
 * 门槛判定：难度低于该 CLI 的门槛 → 自己干（不转给另一个 CLI）。
 * @returns {{ route: string, gated: boolean, reason: string }}
 */
export function applyThreshold({ route, level, thresholds } = {}) {
  if (route !== 'claude' && route !== 'codex') return { route, gated: false, reason: '' };
  const minLevel = thresholds?.[route];
  if (!LEVELS.includes(minLevel)) return { route, gated: false, reason: '' };
  if (levelIndex(level) >= levelIndex(minLevel)) return { route, gated: false, reason: '' };
  return {
    route: 'self',
    gated: true,
    reason: `难度 ${level} 低于 ${route} 的门槛 ${minLevel}，主代理自己干`,
  };
}
