/**
 * 规则引擎：纯函数、确定性。判定顺序 = 数组顺序，首个命中即返回。
 *
 * 设计要点（见 subagent-auto-route-design.md §7）：
 * - 不做任何 LLM 调用；这一层必须能在毫秒级返回。
 * - 兜底规则永远是 `self`：日常单点修改由主代理直接做更便宜。
 * - 实测：一次 codex exec 起手约 31k 输入 token，所以门槛不能定太低。
 */

export const ROUTES = Object.freeze(['self', 'claude', 'codex']);

const MATCHER_KEYS = Object.freeze([
  'always',
  'cwdPrefix',
  'anyKeyword',
  'allKeywords',
  'minPromptChars',
  'minFiles',
]);

export const DEFAULT_RULES = Object.freeze([
  {
    match: { anyKeyword: ['重构', '架构', '方案', '评审', '设计', '为什么', '根因', '权衡'] },
    route: 'claude',
    reason: '需要强推理，交给 claude',
  },
  {
    match: { anyKeyword: ['复现', '编译', '报错', '测试', '异常', '崩溃', '反汇编'] },
    route: 'codex',
    reason: '需要强执行，交给 codex',
  },
  {
    match: { minFiles: 6 },
    route: 'codex',
    reason: '涉及文件多，交给 codex',
  },
  {
    match: { always: true },
    route: 'self',
    reason: '日常单点修改，主代理直接做更便宜',
  },
]);

/** Windows 路径归一：去掉 \\?\ 前缀、统一分隔符、去尾部分隔符、转小写。 */
export function normalizePath(value) {
  let p = String(value ?? '');
  if (p.startsWith('\\\\?\\')) p = p.slice(4);
  p = p.replace(/\//g, '\\');
  p = p.replace(/\\{2,}/g, '\\');
  if (p.length > 2) p = p.replace(/\\+$/, '');
  return p.toLowerCase();
}

/** candidate 是否等于 prefix 或位于其下。`D:\proj_old` 不算在 `D:\proj` 下。 */
export function isUnderPath(candidate, prefix) {
  const c = normalizePath(candidate);
  const p = normalizePath(prefix);
  if (!p || !c) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith('\\') ? p : `${p}\\`);
}

function hasAnyKeyword(prompt, keywords) {
  return keywords.some((k) => typeof k === 'string' && k.length > 0 && prompt.includes(k));
}

function hasAllKeywords(prompt, keywords) {
  return keywords.every((k) => typeof k === 'string' && k.length > 0 && prompt.includes(k));
}

/**
 * 单个 matcher 是否命中。
 * ctx: { prompt, cwd, fileCount? }
 * 未出现的键不参与判定；空数组视为未设置。
 */
export function matchCondition(matcher, ctx) {
  if (!matcher || typeof matcher !== 'object') return false;
  if (matcher.always === true) return true;

  const prompt = String(ctx?.prompt ?? '');

  if (matcher.cwdPrefix != null) {
    if (!isUnderPath(ctx?.cwd ?? '', matcher.cwdPrefix)) return false;
  }
  if (Array.isArray(matcher.anyKeyword) && matcher.anyKeyword.length > 0) {
    if (!hasAnyKeyword(prompt, matcher.anyKeyword)) return false;
  }
  if (Array.isArray(matcher.allKeywords) && matcher.allKeywords.length > 0) {
    if (!hasAllKeywords(prompt, matcher.allKeywords)) return false;
  }
  if (typeof matcher.minPromptChars === 'number' && prompt.length < matcher.minPromptChars) {
    return false;
  }
  if (typeof matcher.minFiles === 'number' && (Number(ctx?.fileCount) || 0) < matcher.minFiles) {
    return false;
  }
  return true;
}

/** 返回 { route, reason, index } 或 null（未命中任何规则）。 */
export function decideByRules(rules, ctx) {
  const list = Array.isArray(rules) ? rules : [];
  for (let index = 0; index < list.length; index += 1) {
    const rule = list[index];
    if (!rule || typeof rule !== 'object') continue;
    if (!matchCondition(rule.match, ctx)) continue;
    return {
      route: rule.route,
      reason: typeof rule.reason === 'string' && rule.reason ? rule.reason : `命中第 ${index + 1} 条规则`,
      index,
    };
  }
  return null;
}

/** 配置校验：无效配置在 apply 阶段就抛错，不要留到运行期静默失败。 */
export function validateRules(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('rules 必须是数组');
  }
  rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (!rule || typeof rule !== 'object') throw new Error(`${at} 必须是对象`);
    if (!ROUTES.includes(rule.route)) {
      throw new Error(`${at}.route 必须是 ${ROUTES.join(' / ')} 之一，收到 ${JSON.stringify(rule.route)}`);
    }
    const match = rule.match;
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      throw new Error(`${at}.match 必须是对象`);
    }
    for (const key of Object.keys(match)) {
      if (!MATCHER_KEYS.includes(key)) {
        throw new Error(`${at}.match 含未知键 ${JSON.stringify(key)}；可用键：${MATCHER_KEYS.join(' / ')}`);
      }
    }
    for (const key of ['anyKeyword', 'allKeywords']) {
      if (match[key] != null && !Array.isArray(match[key])) {
        throw new Error(`${at}.match.${key} 必须是字符串数组`);
      }
    }
    for (const key of ['minPromptChars', 'minFiles']) {
      if (match[key] != null && typeof match[key] !== 'number') {
        throw new Error(`${at}.match.${key} 必须是数字`);
      }
    }
    if (rule.reason != null && typeof rule.reason !== 'string') {
      throw new Error(`${at}.reason 必须是字符串`);
    }
  });
  return rules;
}
