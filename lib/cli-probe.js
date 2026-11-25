/**
 * CLI 可用性探测：在**派发之前**就告诉用户「命令不存在 / PATH 里没有」，
 * 而不是等到第一次派发才抛一个看不懂的 ENOENT。
 *
 * 设计约束：
 *   - 只做 PATH 扫描（同步、纯 fs.stat），不 spawn 子进程。
 *     插件在 apply 阶段是同步执行的，这里不能启动进程，也不该花几百毫秒。
 *   - 结果不带版本号。要版本就由调用方显式跑 `--version`，别把启动路径拖长。
 *   - 错误文案里**不回显用户完整路径**（设置页可以显示，日志/通知里不显示）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** Windows 下常见的可执行后缀；npm 全局装的 CLI 通常是 .cmd。 */
const WINDOWS_EXTS = Object.freeze(['.exe', '.cmd', '.bat', '.ps1']);

function isExecutableFile(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  if (platform === 'win32') return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows 的 PATH 键名大小写不定（Path / PATH），统一取一次。 */
function pathValue(env) {
  for (const key of Object.keys(env ?? {})) {
    if (key.toUpperCase() === 'PATH') return String(env[key] ?? '');
  }
  return '';
}

/**
 * 在 PATH 里找可执行文件。
 *
 * @param {string} command 裸命令名（`codex`）或带分隔符的路径
 * @param {{ env?: object, platform?: string, exts?: string[] }} [options] 测试注入用
 * @returns {{ found: boolean, path: string|null, searched: number, reason: string|null }}
 */
export function findExecutable(command, options = {}) {
  const name = String(command ?? '').trim();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exts = platform === 'win32' ? (options.exts ?? WINDOWS_EXTS) : [''];

  if (!name) return { found: false, path: null, searched: 0, reason: '命令为空' };

  // 带路径分隔符或盘符：当成路径处理，不再遍历 PATH
  const looksLikePath = /[\\/]/.test(name) || /^[A-Za-z]:/.test(name);
  if (looksLikePath) {
    const hasExt = path.extname(name).length > 0;
    const candidates = platform === 'win32' && !hasExt ? exts.map((ext) => name + ext) : [name];
    for (const candidate of candidates) {
      if (isExecutableFile(candidate, platform)) {
        return { found: true, path: candidate, searched: 1, reason: null };
      }
    }
    return { found: false, path: null, searched: candidates.length, reason: '指定的路径不存在或不可执行' };
  }

  const dirs = pathValue(env)
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);

  let searched = 0;
  for (const dir of dirs) {
    for (const ext of exts) {
      searched += 1;
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate, platform)) {
        return { found: true, path: candidate, searched, reason: null };
      }
    }
  }
  return { found: false, path: null, searched, reason: dirs.length === 0 ? 'PATH 为空' : 'PATH 里没有找到' };
}

/**
 * 给设置页用的摘要：不返回 searched 这类内部细节，但保留真实路径（本机、用户自己看）。
 */
export function summarizeCli(command, options = {}) {
  const result = findExecutable(command, options);
  return {
    command: String(command ?? '').trim(),
    found: result.found,
    path: result.path,
    reason: result.found ? null : result.reason,
  };
}

/**
 * 派发前的硬错误文案：说清「缺什么、怎么补、去哪改」，且不泄漏完整路径。
 */
export function missingCliMessage({ channel, command, reason }) {
  const where = channel === 'codex'
    ? 'npm install -g @openai/codex'
    : 'npm install -g @anthropic-ai/claude-code';
  return (
    `找不到 ${channel} CLI（命令：${command}，${reason}）。` +
    `先安装并确认 \`${command} --version\` 能跑：${where}；` +
    `也可以在本插件设置页把「CLI 路径」填成绝对路径。`
  );
}
