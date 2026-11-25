# 发布决策记录

> 对应 `PUBLISH-PLAN.md` 的 P0。定于 2026-11-25。

## 1. 包名与 scope

**决定：`dsh-subagent-native`（无 scope）。**

- 已查 npm registry：`dsh-subagent-native` 与备选 `dsh-native-subagent` 均 404（未被占用）
- 无 scope 的理由：个人项目、无组织；社区目录里同类插件多为无 scope
- 备选（若将来需要）：`@phoenix-mao/dsh-subagent-native`

⚠️ **改名不是现在做**：当前 profile 以 `@local/dsh-subagent-native` 的 junction 挂在运行环境里，
改 package.json 的 name 会让正在使用的插件在下次重启后解析失败。
改名与发布放在同一步（P4）执行，清单见第 6 节。

## 2. 许可证

**决定：MIT。**

- 生态惯例：profile 里 4 个第三方 DSH 插件（better-sidebar / star-radar / whale-widget / opencode-go）全部是 MIT
- 本项目是工具链胶水，无专利可保护，Apache-2.0 的专利条款没有收益
- MIT 对 PR 与二次分发阻力最小
- 版权行：`Copyright (c) 2026 毛烽炜 (Phoenix-Mao)`

## 3. GitHub 仓库

**决定：`Phoenix-Mao/dsh-subagent-native`，当前为 private。**

- 已建并完成首次提交（41 文件 / 6399 行）
- 公开时机：P4 发布时一并转 public（社区目录靠 `owner/repo` 做条目 title）
- 转公开命令：
  ```powershell
  gh repo edit Phoenix-Mao/dsh-subagent-native --visibility public --accept-visibility-change-consequences
  ```

## 4. 文档语言

**决定：README 中文为主（保持现状）；`locale/` 中英双语。**

- 社区目录的 `meta.title` / `meta.description` 必须两语，否则英文环境显示中文
- 代码注释保持中文（作者维护成本最低）
- 英文 README 作为 P3 可选项，不阻塞发布

## 5. 默认预算

**决定：`budget.dailyUsd = 2`（保持代码默认值）。**

理由：装完默认什么都不发生（`tools.enabled` / `auto.enabled` 都是 false），
一旦用户打开派发，$2/天是「能跑几十次」和「被扣爆」之间的合理刹车。

## 6. 改名清单（P4 执行，共 6 处）

改名前先在 profile 外备份。顺序如下：

1. `package.json`：`name` → `dsh-subagent-native`
2. `lib/config.js`：`PACKAGE_NAME` → `'dsh-subagent-native'`
3. 插件自带 `cordis.patch.yml`：insert 列表里的 `name` → `dsh-subagent-native`
4. profile `package.json`：`dependencies` 的 key 与 `dsh.profile.bundles` 数组项
5. profile `cordis.patch.yml`：`- id: subagent-native` 不用改（按 id 定向），确认无 `name:` 字段
6. `profiles/desktop/node_modules/@local/dsh-subagent-native` junction → 重建为
   `node_modules/dsh-subagent-native`

验证：重启 DSH → 设置页「子代理」出现 → `GET /api/subagent-native/history` 有响应。

回滚：把上面 6 处改回 `@local/...` 即可。

## 7. 已知不做的项

| 项 | 原因 |
|---|---|
| 英文 README | 不阻塞；P3 可选 |
| `detail/DETAIL.md` 详情图 | 纯观感，P3 |
| 跨平台（macOS/Linux）CI 强制 | 目前只在 Windows 验证，Linux 先跑成实验性 job |
