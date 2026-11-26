# 发布计划：subagent-native → DSH 社区

> 状态：草案（2026-11-25）｜目标：让别的 DSH 用户能一条命令装上并安全使用本机 codex/claude 通道

## 一、发布路径（已核实的事实）

| 环节 | 事实 |
|---|---|
| 分发载体 | **npm 包**，`package.json` 声明 `dsh.bundle.patch`；UI 插件还要 `dsh.client` + `./client` 导出 |
| 市场读取 | 社区目录 `dsh-plugin-catalog`（jsdelivr `index.json`，格式 1，约 1.3 万条目），条目字段：`name / title(owner/repo) / description{en,zh} / homepage / repository / metadata.category / versions[{version, source:{type:npm}, engines:{dsh}}]` |
| 收录方式 | 目录由 awesome-dsh-plugin 自动生成 → **发布 npm + 有 GitHub 仓库 + 合适关键词**即可被收录，无需人工投稿流程 |
| 显示元数据 | `locale/en.json`、`locale/zh.json` 里的 `meta.title` / `meta.description`；`exports` 要有 `./locale/*.json` 与 `./icon` |
| 图标 | SVG/PNG/JPEG/WebP ≤ 256 KiB，原创或有再分发许可 |
| 详情图（可选） | `docs/DETAIL.md` 恰好一行图片 + `meta.detail`；单张 640×300 SVG |
| 版本兼容 | 目录条目按 `engines.dsh` 与运行版本核对 → 必须写准 |

## 二、当前差距（对照发布要求）

| 项 | 现状 | 要求 | 阻塞级别 |
|---|---|---|---|
| 包名 | ✅ `dsh-subagent-native`（2026-11-26 已改，7 处） | 公共 npm 名（已查重，可用） | ✅ |
| `engines.dsh` | 无 | 例：`>=0.2.2-rc.5 <0.3.0` | P0 |
| 显示元数据 | 无 locale | en/zh 的 title + description | P0 |
| 图标 | 无 | 原创 SVG + `./icon` | P0 |
| exports / files | `.` + `./client` | 补 `./locale/*.json`、`./icon`、`docs`、`LICENSE` | P0 |
| patch 行名 | ✅ 已改为 `dsh-subagent-native` | 与包名一致 | ✅ |
| LICENSE | 无 | MIT（待定） | P0 |
| README | 中文技术文档 | 中英双语：安装、前置依赖、安全、成本口径 | P1 |
| 默认安全值 | `auto.enabled=false`（好）、`budget.dailyUsd=0`（无上限） | 已收紧：`claude.permissionMode=plan`、`codex.sandbox=read-only`、`budget.dailyUsd=2` | ✅ 已改 |
| 前置依赖 | 本机 codex/claude CLI + 中转站配置 | 启动自检 + 友好报错 + 文档 | P1 |
| CI | 本地 111 用例 | GitHub Actions：test + lint + `npm pack` 校验 | P1 |
| 跨平台 | 只在 Windows 验过 | macOS/Linux 至少验证参数构造与进程终止 | P2 |
| 详情图 | 无 | 可选，提升市场观感 | P3 |

## 三、分阶段计划

> **状态（2026-11-25/26 更新）**：代码项与 P1 打包合规已完成（143 个单测全过，
> `npm pack` 27 文件 / 62.9 kB）；剩余 P0 改名（推迟到 P4）、P2 文档、P3 跨平台与安全复核、P4 发布。

### ✅ 已完成（原 P0 / P1 的代码部分）

| 项 | 落点 | 验证 |
|---|---|---|
| 默认值收紧 | `claude=plan`、`codex=read-only`、`budget=2`、`tools=false`、`auto=false` | `config.test.js`（含「显式放开」用例） |
| 工具暴露闸门 | `tools.enabled` 关时不注册 provider；`dsh-tool-subagent` 只记日志等 provider 出现 | 实测：两开关关闭后模型侧看不到 `subagent_native_*`（0 次） |
| 成本口径修正 | 失败运行按**耗时**外推（p90 封顶）、预算计入在飞+本次预占、1h 缓存写按 1.6 倍、`evidenceChars` 死参数删除 | `history/budget` 用例；真实账单行回归 |
| 变更观测 | `lib/git-snapshot.js`：按 cwd 限定范围、porcelain 前后差集、附到完成通知与 `runs.jsonl` | 真实 git 集成测试（cwd 内抓得到、cwd 外不误报） |
| 删除作者硬编码 | 作者本机规则/加分、`shouldJudge/needsJudge` 死代码、包名常量化为 `PACKAGE_NAME` | 断言默认规则序列化后不含任何盘符路径 |
| 目录护栏 | `lib/guard.js`：拒绝主目录/盘符根/`~/.dsh`/profile；可写运行不再跳过 git 检查 | `guard.test.js` 5 例 |
| 停止信号 | 非接力派发也接 `turnSignal`（`AbortSignal.any`） | — |
| 写接口校验 | `POST /config`、`/history/clear` 要求同源 + JSON | — |
| **价目可配**（发布阻塞项） | `lib/history.js` 的 `DEFAULT_PRICING` + `mergePricing/pricingForChannel`；`lib/config.js` 新增 `pricing` 段；`buildRecord` 接受自定义价并标 `costEstimate.custom` | `history.test.js` 7 例 + `config.test.js` 1 例 |
| **测试夹具脱敏**（发布阻塞项） | 测试里的作者本机路径全部换成 `D:\proj\app`；默认规则断言改为「不含任何盘符路径」 | 143 用例全过 |

### P0 · 决策（0.5 天，需要你拍板）

产出：5 个决定落实为文档。

1. 包名与 scope：`dsh-subagent-native`（无 scope）或 `@<你的npm名>/dsh-subagent-native`
2. 许可证：MIT / Apache-2.0 / 其他
3. GitHub 仓库：新建 `dsh-subagent-native`（社区目录靠它做 title）
4. 是否双语：中文为主 + 英文（市场描述必须两语）
5. 社区默认预算值：已定 `dailyUsd=2`（代码已改，可在发布时调整）

验收：以上 5 项写进 `PUBLISH-DECISIONS.md`。

### P1 · 打包合规（1 天）

- [x] `package.json`：去 `private`、`engines.dsh: ">=0.2.2-rc.5 <0.3.0"`、keywords、repository / homepage / bugs、`license: MIT`+`author`、`exports`（`./locale/*.json` / `./icon` / `./package.json`）、`files` 补齐 — **2026-11-25 完成**
- [x] `locale/en.json` + `locale/zh.json`：`meta.title` / `meta.description` 中英双语 — 完成
- [x] `icon.svg`：原创单色线条（24×24，`currentColor`，541 B）— 完成
- [ ] `cordis.patch.yml`：行名改为发布名 — **推迟到 P4 与包名一起改**（见 `PUBLISH-DECISIONS.md` §6）
- [x] `LICENSE`（MIT）— 完成
- [x] `npm pack --dry-run` 核对：27 个文件 / 62.9 kB（含 LICENSE、README、locale、icon、docs；不含 test/）— 完成

验收：`npm pack --dry-run` 列表与设计一致（✅）；解包目录在干净 profile 里能装（P4 做）。

### P2 · 文档与默认值（1 天）

- [x] README 补齐：安装（npm / 源码两种）、前置依赖表（自检命令 + 没装会怎样）、快速开始、
      故障排查表（2026-11-26 完成；英文版仍待做）
- [x] 默认值调整（见上表）
- [x] 前置依赖自检：`lib/cli-probe.js` 只扫 PATH（不 spawn），设置页显示每条通道的探测结果，
      派发前现测一次并给「装什么 / 怎么改路径」的中文错误；新增「CLI 路径」输入框
- [x] 错误信息：`missingCliMessage` 只带命令名与原因，不回显绝对路径（有单测断言）
- [ ] README 英文版（P3 可选）

验收：找一个没装过的 DSH 环境，按 README 从零走通（不许问作者）。← 仍需在干净环境验证

### P3 · 质量门（1 天）

- [x] GitHub Actions：三个 job **全部必过**——Windows/Node 24（test+lint+pack）、
      Windows/Node 22（test）、Ubuntu/Node 24（test+lint）— 2026-11-26
- [x] **Node 22 已修**：根因是进程退出后的 200ms「排空定时器」被 `unref()`，而它正是该分支
      唯一的结算来源；假句柄场景下没有真实子进程撑住事件循环 → Promise 永不 settle →
      Node 22 的 `node:test` 判定 pending 后取消。改为 ref 并在 `finish()` 里主动清掉。
      Node 22 / 24 上均 151 过 + 1 跳过 + 0 取消
- [x] **Linux 冒烟**：ubuntu/Node 24 全量用例通过（含 POSIX-only 的可执行位用例）
- [ ] macOS 冒烟；「真实 CLI 进程终止」在非 Windows 上仍只在 Windows 观察过
- [x] DSH 版本兼容：README 新增「兼容性」表，列出用到的 6 个 DSH 接口与各自失效表现
      （0.2.2-rc.5 上运行中；**改完代码后的实际装载验证要重启 DSH**）
- [x] 安全复核：真跑 `npm pack` 解包人工过清单——26 文件 / 62.4 kB，扫描无 token、
      无本机绝对路径、无 ATE 相关字样；只剩作者名（`author` 与 LICENSE 版权行，属预期）。
      同时把 `docs/` 从 `files` 移出（内部分计划文档不该随包发布）

验收：CI 绿；两平台冒烟通过；包内无敏感信息。

### P4 · 发布（0.5 天）

- [x] `npm publish` — **2026-11-26 已发布 `dsh-subagent-native@0.1.0`**
      （npm 目前走 staged publishing：登录时会先建一个 `0.0.0-stage` 临时占位版本，
      真实版本 `0.1.0` 随后生效，`dist-tags.latest = 0.1.0`）
- [x] GitHub 仓库转 public（社区目录靠 `owner/repo` 生成条目）
- [ ] GitHub Release（含变更说明与已知限制）← 正在做
- [ ] 用**干净 profile** 从 npm 装一次（不是本地 link），确认：工具可用、设置页出现、历史落盘、预算生效
- [ ] 等社区目录收录（自动），核对条目字段：description 中英、engines、repository、category

验收：市场里能搜到并安装；安装后「开箱可用」而不需要作者指导。

### P5 · 首周运营（持续）

- [ ] 盯 issue：CLI 版本差异、非 Windows 环境、成本口径误解
- [ ] 发布 0.1.x 补丁：只修安装与兼容问题，不加大功能
- [ ] 收集「真实派发数据」（cost/失败率），决定是否默认打开 `auto.dispatch`

## 四、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **provider 契约随 DSH 版本变** | 升级 DSH 后插件静默失效 | `engines.dsh` 写准 + 启动自检 + 失败时明确报错；README 写「DSH 升级后先看这里」 |
| **子代理能改文件** | 用户数据风险 | 默认关 auto；文档显著标注；`sandbox`/`permissionMode` 可配 |
| **成本口径被误读** | 用户以为「一定便宜」 | README 写清：折扣是某中转站渠道价、随站与活动变化，插件只做估算 |
| **只验证了 Windows** | macOS/Linux 报错 | P3 跨平台冒烟；参数按平台差异列文档 |
| **CLI 版本漂移** | 事件格式变化导致误判完成 | 已有「不认 exit code、只认完成事件 + 失败事件即终止」的防御；补一条 CLI 版本探测与警告 |
| **包名冲突** | 发布失败 | P0 先查重 |

## 五、时间线（合计约 4 天工作量）

```
P0 决策     0.5d  ──► P1 打包 1d ──► P2 文档 1d ──► P3 质量门 1d ──► P4 发布 0.5d ──► P5 运营
```

P0→P1 可并行（图标、locale 文案可先写）；P2 依赖 P1 的默认值定稿。
