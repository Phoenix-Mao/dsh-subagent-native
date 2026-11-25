/**
 * 改动观测（最小版）：运行前后做一次 git 快照，把「它到底改了哪些文件」作为客观证据带回。
 *
 * 为什么需要：子代理能直接写文件，而完成通知里只有它自己说的话。主代理被要求「审阅核对」，
 * 却没有可核对的依据。这里不调模型、不花 token，只用 git 的只读命令拿事实。
 *
 * 边界与教训：
 *   - 只在 git 工作树里工作；不是 git 目录返回 null。
 *   - **必须按 cwd 限定范围**：用户主目录可能本身就是 git 仓库（实测遇到过），
 *     不限范围会把整个主目录的改动都算进来，又慢又误报。
 *   - 不用 `git stash create`（在大仓库上很贵）；用 `git status --porcelain` 的前后差集判断归属。
 */
import path from 'node:path';

const MAX_FILES = 50;
const MAX_STAT_CHARS = 1200;

/** 用 subprocess 跑一条命令并收集输出（只读用途）。 */
export function runCapture(spawn, argv, cwd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let handle = null;
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    try {
      handle = spawn({ argv, cwd, stdio: { stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 });
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }

    timer = setTimeout(() => {
      try {
        handle?.terminate?.();
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, stdout, stderr: `${stderr}\n(timeout)` });
    }, Math.max(500, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();

    handle.stdout?.on('data', (chunk) => {
      if (stdout.length < 256 * 1024) stdout += String(chunk);
    });
    handle.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk);
    });
    if (typeof handle.done?.then === 'function') {
      handle.done.then(
        (facts) => finish({ ok: (facts?.exitCode ?? 0) === 0, stdout, stderr }),
        () => finish({ ok: false, stdout, stderr }),
      );
    } else {
      finish({ ok: true, stdout, stderr });
    }
  });
}

/** `git status --porcelain` → [{ code, path }]。 */
export function parseStatus(statusText) {
  const rows = [];
  for (const line of String(statusText ?? '').split('\n')) {
    const raw = line.replace(/\r$/, '');
    if (raw.trim().length < 4) continue;
    const code = raw.slice(0, 2);
    let file = raw.slice(3).trim();
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    if (file.includes(' -> ')) file = file.split(' -> ').pop().trim();
    if (file) rows.push({ code, path: file });
  }
  return rows;
}

/** `git diff --stat` → 改动文件名列表。 */
export function parseStatFiles(statText) {
  const out = [];
  for (const line of String(statText ?? '').split('\n')) {
    const match = /^\s*(.+?)\s+\|\s+\d+/.exec(line);
    if (match) out.push(match[1].trim());
  }
  return out.slice(0, MAX_FILES);
}

const git = (spawn, cwd, args, timeoutMs) => runCapture(spawn, ['git', ...args], cwd, timeoutMs);

/**
 * 运行前快照。返回 null 表示不是 git 工作树（或 git 不可用）。
 * @returns {Promise<null | { toplevel: string, rel: string, status: Array<{code:string, path:string}> }>}
 */
export async function captureBaseline({ spawn, cwd }) {
  if (typeof spawn !== 'function' || !cwd) return null;
  try {
    const inside = await git(spawn, cwd, ['rev-parse', '--is-inside-work-tree'], 3000);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;

    const top = await git(spawn, cwd, ['rev-parse', '--show-toplevel'], 3000);
    const toplevel = top.ok ? top.stdout.trim() : '';
    const rel = toplevel ? path.relative(toplevel, cwd).replace(/\\/g, '/') : '';
    const status = await git(spawn, cwd, ['status', '--porcelain', '--', '.'], 5000);
    return { toplevel, rel, status: parseStatus(status.stdout) };
  } catch {
    return null;
  }
}

/**
 * 运行后对比：用前后 status 的差集判断「这次运行改了什么」。
 * @returns {Promise<null | { stat: string, changedFiles: string[], untrackedAdded: string[] }>}
 */
export async function diffSince({ spawn, cwd, baseline }) {
  if (!baseline) return null;
  try {
    // pathspec 相对当前工作目录：'.' 就是「cwd 这棵子树」
    const scope = '.';
    const status = await git(spawn, cwd, ['status', '--porcelain', '--', scope], 5000);
    const now = parseStatus(status.stdout);
    const before = new Map(baseline.status.map((item) => [item.path, item.code]));

    const changed = now.filter((item) => {
      const prev = before.get(item.path);
      return prev === undefined || prev !== item.code;
    });
    const stat = await git(spawn, cwd, ['diff', '--stat', '--', scope], 5000);

    return {
      stat: String(stat.stdout ?? '').slice(0, MAX_STAT_CHARS),
      changedFiles: changed.filter((item) => item.code !== '??').map((item) => item.path).slice(0, MAX_FILES),
      untrackedAdded: changed.filter((item) => item.code === '??').map((item) => item.path).slice(0, MAX_FILES),
    };
  } catch {
    return null;
  }
}

/** 给完成通知末尾追加的文本（最多 30 行）。 */
export function describeChanges(diff) {
  if (!diff) return '';
  const lines = ['', '## 改动清单（git，客观记录）'];
  if (diff.changedFiles.length > 0) {
    for (const file of diff.changedFiles.slice(0, 20)) lines.push(`- 修改：${file}`);
  }
  if (diff.untrackedAdded.length > 0) {
    for (const file of diff.untrackedAdded.slice(0, 10)) lines.push(`- 新增：${file}`);
  }
  if (diff.changedFiles.length === 0 && diff.untrackedAdded.length === 0) {
    lines.push('- 本次运行没有检测到改动');
  }
  return lines.join('\n');
}
