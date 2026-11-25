/**
 * 发布一致性守卫：包名散落在 4 个地方，改一处漏一处会导致「装上了但设置页空白 / 配置保存失败」。
 * 这些用例跑在 CI 里，改名时忘记同步任何一处都会立刻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PACKAGE_NAME } from '../lib/config.js';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));

test('package.json 的 name 与 config.js 的 PACKAGE_NAME 一致', () => {
  assert.equal(PACKAGE_NAME, pkg.name);
});

test('client.js 的 ModuleLoader id 与包名一致', () => {
  const client = read('../client.js');
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client);
  assert.ok(match, 'client.js 应调用 __ModuleLoader__.load({ id: ... })');
  assert.equal(match[1], pkg.name, '客户端模块 id 必须等于包名，否则设置页不会挂载');
});

test('cordis.patch.yml 的 insert 名与包名一致', () => {
  const patch = read('../cordis.patch.yml');
  assert.ok(
    patch.includes(`name: '${pkg.name}'`),
    `cordis.patch.yml 里应以 name: '${pkg.name}' 插入插件`,
  );
});

test('发布包不应声明 private，且必须带 engines.dsh', () => {
  assert.notEqual(pkg.private, true, '发布前要能 npm publish');
  assert.ok(pkg.engines?.dsh, 'engines.dsh 决定社区目录的兼容性判定');
  assert.ok(pkg.license, '必须声明 license');
  assert.ok(pkg.repository?.url, '社区目录用 repository 生成条目链接');
});
