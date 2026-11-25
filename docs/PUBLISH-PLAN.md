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
| 包名 | `@local/dsh-subagent-native` + `private: true` | 公共 npm 名（需查重） | P0 |
| `engines.dsh` | 无 | 例：`>=0.2.2-rc.5 <0.3.0` | P0 |
| 显示元数据 | 无 locale | en/zh 的 title + description | P0 |
| 图标 | 无 | 原创 SVG + `./icon` | P0 |
| exports / files | `.` + `./client` | 补 `./locale/*.json`、`./icon`、`docs`、`LICENSE` | P0 |
| patch 行名 | `@local/dsh-subagent-native` | 改为发布名 | P0 |
| LICENSE | 无 | MIT（待定） | P0 |
| README | 中文技术文档 | 中英双语：安装、前置依赖、安全、成本口径 | P1 |
| 默认安全值 | `auto.enabled=false`（好）、`budget.dailyUsd=0`（无上限） | 已收紧：`claude.permissionMode=plan`、`codex.sandbox=read-only`、`budget.dailyUsd=2` | ✅ 已改 |
| 前置依赖 | 本机 codex/claude CLI + 中转站配置 | 启动自检 + 友好报错 + 文档 | P1 |
| CI | 本地 111 用例 | GitHub Actions：test + lint + `npm pack` 校验 | P1 |
| 跨平台 | 只在 Windows 验过 | macOS/Linux 至少验证参数构造与进程终止 | P2 |
| 详情图 | 无 | 可选，提升市场观感 | P3 |

## 三、分阶段计划

> **状态（2026-11-25 更新）**：P0 代码项与 P1 加固项已完成并通过 143 个单测；
> 发布侧（打包合规 / 文档 / CI）尚未开始。

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

- [ ] `package.json`：去 `private`、加 `engines.dsh`（`>=0.2.2-rc.5 <0.3.0`）、`keywords: ["dsh","dsh-plugin","subagent","codex","claude","deepseek-harness"]`、`repository`、`license`、`exports`/`files` 补齐（locale / icon / docs）
- [ ] `locale/en.json` + `locale/zh.json`：`meta.title` / `meta.description`（说清「做什么、在哪看、有什么风险、关掉会怎样」）
- [ ] `icon.svg`：原创、单色可读、≤256 KiB
- [ ] `cordis.patch.yml`：行名改为发布名（代码里已有 `PACKAGE_NAME` 常量，改一处即可）
- [ ] `LICENSE` 文件
- [ ] `npm pack` 后核对真实文件清单（不能靠 `files` 推断）

验收：`npm pack --dry-run` 列表与设计一致；解包目录在干净 profile 里能装、provider 注册、工具出现。

### P2 · 文档与默认值（1 天）

- [ ] README（中英）：一句话定位 / 架构图 / **前置依赖（codex-cli、claude、各自配置）与「没装会怎样」** / 安装 / 设置页每个开关的含义 / 安全边界（子代理能改文件、不经过 DSH 审批） / 成本口径（1 折、4 折按某中转站账单校准，换站不准） / 故障排查
- [x] 默认值调整（见上表）
- [ ] 前置依赖自检：插件启动时检测 CLI 是否存在，缺了给明确提示而不是等派发才报错
- [ ] 错误信息过一遍：用户能看懂、不泄漏本机路径细节

验收：找一个没装过的 DSH 环境，按 README 从零走通（不许问作者）。

### P3 · 质量门（1 天）

- [ ] GitHub Actions：`node --test`（136 用例）+ lint + `npm pack` 文件校验
- [ ] 跨平台冒烟：macOS / Linux 上至少验证 `buildCodexArgs` / `buildClaudeArgs` 与进程终止；参数差异记进 README
- [ ] DSH 版本兼容：在 0.2.2-rc.5 上装一遍；记录 provider 契约的版本敏感性
- [ ] 安全复核：无 token/本机路径进包；`npm pack` 内容人工过一遍

验收：CI 绿；两平台冒烟通过；包内无敏感信息。

### P4 · 发布（0.5 天）

- [ ] `npm publish --access public`
- [ ] GitHub Release（含变更说明与已知限制）
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
