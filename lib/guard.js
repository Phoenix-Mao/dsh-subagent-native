/**
 * 运行目录护栏：拒绝把子代理丢进「可写范围远大于预期」的目录。
 *
 * 为什么需要：子代理用的是 CLI 自己的沙箱，写到哪我们控制不了太多；
 * 但至少可以把「让它在主目录 / 盘符根 / DSH 配置目录里跑」这种明显危险的选择拦掉。
 */
import os from 'node:os';
import path from 'node:path';

function sameOrUnder(target, base) {
  const t = target.toLowerCase();
  const b = base.toLowerCase();
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
}

/**
 * @param {string} cwd
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkCwd(cwd) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return { ok: false, reason: '工作目录为空' };
  if (!path.isAbsolute(raw)) return { ok: false, reason: `工作目录不是绝对路径：${raw}` };

  const resolved = path.resolve(raw);
  const home = os.homedir();
  const root = path.parse(resolved).root;
  const dshHome = path.join(home, '.dsh');
  const profileDir = process.env.DSH_PROFILE_DIR || '';

  if (sameOrUnder(resolved, dshHome)) {
    return { ok: false, reason: '拒绝在 DSH 配置目录里运行子代理（可能改写插件与凭据）' };
  }
  if (profileDir && sameOrUnder(resolved, profileDir)) {
    return { ok: false, reason: '拒绝在 profile 目录里运行子代理' };
  }
  if (path.normalize(resolved).toLowerCase() === path.normalize(home).toLowerCase()) {
    return { ok: false, reason: '拒绝在用户主目录运行子代理（可写范围过大）' };
  }
  if (path.normalize(resolved).toLowerCase() === path.normalize(root).toLowerCase()) {
    return { ok: false, reason: '拒绝在盘符根目录运行子代理（可写范围过大）' };
  }
  return { ok: true };
}
