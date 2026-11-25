# subagent-native

把本机**原生** `codex` / `claude` CLI 注册成 DSH 的 subagent provider，并在模型不主动派时由框架兜底触发。

## 为什么不是「自己 spawn + 注入」（auto-delegate 的老路）

注册成官方 provider 后，官方那一整套自动生效：catalog、完成通知、容量限制、团队任务板、`subagent/start|end` 事件。
自己 spawn 再注入只拿到「跑一次」，拿不到这些，还得自己管进程与回注。

## 为什么不用官方 `subagent-codex` provider

它用包内固定的 app-server（codex 0.153.4），初始化时自称 `deepseek-harness`，中转站认不出是 Codex 客户端，
按**标准 API 价**收费。2026-11-24 账单反推证实：11 次请求 $0.52，逐行与标准价吻合、与 1 折不符。

原生 CLI（`codex_exec/0.169.1`）同样请求实付 **$0.005423**（-90%）。

## 两条通道

| provider | 工具 | 说明 |
|---|---|---|
| `native-codex` | `subagent_native_codex` | 原生 codex CLI，一次性执行 |
| `native-claude` | `subagent_native_claude` | 原生 Claude Code CLI，一次性执行 |

模型/强度留空时用 CLI 原生配置（`~/.codex/config.toml`、`~/.claude/settings.json`），历史里记录**实际生效值**。

## 框架兜底触发（`auto`）

模型实测不会主动调用子代理（4 天 400+ 条消息、5000+ 次工具调用、0 次主动派发），所以提供兜底：

```yaml
- id: subagent-native
  config:
    auto:
      enabled: true
      mode: dispatch          # observe = 只判定不派发；dispatch = 真派
      thresholds:             # 难度低于门槛就自己干
        claude: high
        codex: medium
      minPromptChars: 10
    codex:
      sandbox: workspace-write
```

判定流程（`agent/pre-step`，每轮一次）：规则表定去向 → 难度打分 → 门槛闸门 → 通过则 `subagents.startActivation`。
路由行会显示在运行时上下文：`【子代理路由】本轮：codex（理由）；难度 low；会派发`。

### 让出（关键）

只派发而不告诉主代理「别自己再做」，成本是**叠加**而不是替代——主代理会一边等一边把同一件事做了。
所以派发成功后会注入一行让出指令：`本任务已交给 native-codex（3 份并行），负责 a.js、b.js。本轮不要自己执行同一件事……收到完成通知后审阅汇总；若通知报告失败或中断，再自己接手。`
`auto.yield: false` 可关闭，`auto.yieldMinutes`（默认 20）控制失效时间。

### 成本估算口径

按中转站账单校准（2026-11-25）：

| 通道 | 输入 | 缓存读 | 缓存写 | 输出 |
|---|---|---|---|---|
| codex（1 折） | $0.20/M | $0.01/M | $0.25/M | $1.00/M |
| claude（4 折） | $1.60/M | $0.08/M | $2.00/M | $8.00/M |

**codex 的 `input_tokens` 包含缓存命中部分**，计价时要先减掉（`input - cached`）再按普通输入价算；claude 的 `input_tokens` 不含缓存，不减。

#### 换站必须改价目（否则护栏失效）

上面是**某一个中转站的渠道价**，不是公开价。你的站不一样就一定要覆盖，否则成本估算和预算护栏都是错的：

```yaml
- id: subagent-native
  config:
    pricing:
      codex:
        input: 0.5          # 美元 / 百万 token
        output: 2.5
        cacheRead: 0.05
        cacheWrite: 0.6
      claude:
        input: 2.0
        output: 10.0
```

- 只覆盖你填的字段，没填的沿用内置值
- `inputIncludesCached` 是**通道口径**不是价格：codex 恒为 `true`、claude 恒为 `false`，换站不要改；除非你的站改了计费方式
- 被覆盖过的记录会带 `costEstimate.custom: true`，便于事后分清哪些是按自定义价算的
- 界面「调用记录」的成本列沿用同一份价目

验证方法：跑一次已知 token 数的任务，把估算值和账单对照，误差应在 5% 以内。


没拿到 usage 的运行（取消/超时/异常退出）按同通道最近 5 次中位数回填，并标 `estimated: true`，避免「最贵的失败记成 $0」。

### 简报分段额度

以前是把整篇简报拼好再从尾部截断，方案一长就会把「边界 / 文件 / 验收 / 输出」整段切掉——而那几段恰恰是防乱探索的关键。
现在按段分配：固定段（边界、文件、验收、输出）先占位，剩余额度按权重分给可伸缩段（方案 0.5 / 目标 0.35 / 证据 0.15），任何一段都不会被别的段挤没。

## 并行扇出（`team`）

框架兜底触发时，如果提示里出现 **≥2 个目标（文件路径）**，自动拆成 N 份并行派发：

```yaml
    team:
      enabled: true
      maxParallel: 3      # 最多拆几份（上限 6）
      minTargets: 2       # 至少几个目标才扇出
```

- **只做确定性拆分**：从提示里抽路径，按路径分组，同一文件绝不跨组；抽不到 ≥2 个目标就退回单发
- 每份的简报会写明「第 i/n 份，其他份由别的执行代理同时处理，别越界」
- 结果通过官方完成通知逐条回注（每份一条）
- 历史里每条记录带 `fanout: { index, total }`，可以和决策日志对上

不做语义拆分（按模块/职责分）——那需要模型参与，成本和不确定性都更高。

## 设置页

设置 → **子代理**，两个 tab：

**环境与阈值**
- 触发模式（observe / dispatch）
- 最低难度：claude / codex 各一个下拉
- 最短提示长度、并行扇出开关与份数
- **预算护栏**：日上限（美元）+ 今日已花进度条
- codex 卡：模型、强度（low…ultra）、沙箱
- claude 卡：模型、强度（low…max）、权限模式

保存写回 profile 的 `cordis.patch.yml`，插件自动重载。

**调用记录**
- 汇总：今日/累计/估算成本/平均耗时/按触发来源/未完成数
- runs 表：时间 / 通道 / 模型 / 触发 / 扇出 / 耗时 / 成本 / 结果
- decisions 表：时间 / 路由 / 动作 / 难度 / 理由
- 清空按钮

## 预算护栏

```
日上限 dailyUsd（0 = 不限制）
今日估算成本 ≥ 上限 → 框架派发变 skipped，模型直接调用被 provider 拒绝
```

只能做**事后估算**（一次 CLI 花多少要跑完才知道）。估算按渠道价：codex 1 折、claude 4 折。

账本独立存放（`.subagent-native/ledger.jsonl`），**与展示历史完全分开**：关历史、裁剪历史、点「清空记录」都不会让今日额度复位。首次启动会用历史补种，避免升级后额度被重置。

### 改动观测（git）

每次运行前后各做一次 git 快照，把**客观改动清单**附在完成通知末尾，并写进 `runs.jsonl` 的 `git` 字段：

- 只在 git 工作树里生效；不是 git 目录会明确写「无法列出改动」
- **按 cwd 限定范围**（pathspec 用 `.`），不会把仓库其他地方的改动算进来
- 用 `git status --porcelain` 的前后差集判断归属，不用昂贵的 `git stash create`
- 只报文件名和 `diff --stat`，不附完整 patch（需要时主代理自己跑 `git diff`）

## 默认值（安全优先）

| 项 | 默认 | 说明 |
|---|---|---|
| `tools.enabled` | `false` | **不注册通道**：模型看不到子代理工具。打开后才注册 provider |
| `auto.enabled` | `false` | 自动派发需显式打开（也会顺带注册通道） |
| `auto.mode` | `observe` | 先只看判定，不派发 |
| `team.enabled` | `false` | 并行写同一工作区有冲突风险 |
| `relay.enabled` | `false` | 两段串行，成本翻倍 |
| `codex.sandbox` | `read-only` | 不继承 CLI 原生配置（那里可能是 full-access） |
| `claude.permissionMode` | `plan` | 只读分析；要写需显式改成 `acceptEdits` |
| `budget.dailyUsd` | `2` | 默认就有刹车 |

**装完默认什么都不会发生**：两个开关都关时插件不注册 provider，`dsh-tool-subagent` 只会记一条日志、等 provider 出现再挂载，所以模型侧连工具都看不到（实测确认）。用户打开「允许模型调用」或「框架派发」后，通道才注册。

## 目录护栏

子代理运行前会校验工作目录，以下一律拒绝并给出原因：

- 用户主目录、盘符根目录（可写范围远大于预期）
- `~/.dsh` 与 profile 目录（可能改写插件与凭据）

可写运行（非只读）不再传 `--skip-git-repo-check`，保证改坏了还能用 git 回滚；只读运行才跳过。

## HTTP 写接口

`POST /config` 与 `POST /history/clear` 只接受 **同源 + `content-type: application/json`** 的请求，防跨站改写权限配置。

## 其他工程约定

- 判定规则与难度打分**不含任何作者本机路径**（默认规则只按关键词分类：推理类→claude、执行类→codex）。
- 插件包名只在 `lib/config.js` 的 `PACKAGE_NAME` 一处定义（发布时改这里 + `package.json` + `cordis.patch.yml`）。

## 历史（详细）

`<profile>/.subagent-native/runs.jsonl`（每次运行一行）：

时间 / 耗时 / 通道 / provider / **生效模型与强度** / cwd / **触发来源（model|framework）** / 父会话 /
提示长度与前 200 字 / 答复长度与前 200 字 / **token 用量** / 成本估算（codex 按 1 折价）/
stopReason / exitCode / 事件数 / 诊断 / stderr 尾部。

`decisions.jsonl`：每次判定一行（含 observe 模式），记录候选路由、最终路由、理由、难度信号。

接口：`GET /api/subagent-native/history`、`POST /api/subagent-native/history/clear`。

## 已知限制

- **CLI 是一次性执行**：不能追问、不能多轮。协作只能靠 DSH 侧编排。
- **简报质量决定成败**：简报太泛会让 codex 到处探索（实测一次 193s / 46 万 token，真实成本约 $0.039；精确简报的 3 份并行合计约 $0.025，还快 3 倍）。
- **claude 的渠道价**：内置值按 Claude Code 通道 4 折（$1.60/$8.00/$2.00/$0.08）。换站必须用 `config.pricing` 覆盖，插件只做估算，真账以控制台为准。
- provider 契约跟随 DSH 版本（0.2.2-rc.5 实测）。

## 工程注意

- `runs.jsonl` / `decisions.jsonl` 超限时**原子压缩**（写临时文件再 rename）；读失败时放弃压缩，绝不把空内容写回去。
- 路径去重按 Windows 规则归一（`src/a.js` 与 `src\a.js` 视作同一文件），避免同一文件被拆给两个可写代理。
- `team.maxParallel: 1` 表示不扇出（不是「拆两份」）。
- 判定日志重启后从文件恢复最近 200 条，文件超 1MB 保留最近 200。
- 配置解析/校验集中在 `lib/config.js`（纯函数，有单测）；`index.js` 只留编排与接口。
