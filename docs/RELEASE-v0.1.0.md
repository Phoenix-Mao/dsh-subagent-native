# v0.1.0 · 首次发布

把本机**原生** `codex` / `claude` CLI 注册成 DSH 的 subagent provider。

## 功能

- 两条通道：`native-codex`（`subagent_native_codex`）、`native-claude`（`subagent_native_claude`）
- 框架兜底触发：规则表 → 难度打分 → 门槛闸门 → 派发 → **让出**（防止主代理重复执行）
- 并行扇出：提示里出现 ≥2 个文件路径时确定性拆分，同一文件绝不跨组
- 角色接力：claude 只出方案 → codex 照做，方案段静默不回注
- 预算护栏：独立账本（与展示历史分离）、可配置价目、在飞预占
- 改动观测：运行前后 git 快照，完成通知里附客观改动清单
- 目录护栏：拒绝主目录 / 盘符根 / DSH 配置目录
- 设置页：阈值、扇出、预算、两个通道的模型与强度、CLI 路径、调用记录与判定日志

## 安全默认（装完默认什么都不发生）

| 项 | 默认 |
|---|---|
| `tools.enabled` / `auto.enabled` | `false`（不注册 provider，模型侧看不到工具） |
| `codex.sandbox` | `read-only` |
| `claude.permissionMode` | `plan` |
| `budget.dailyUsd` | `2` |

## 兼容性

- **DSH** `>=0.2.2-rc.5 <0.3.0` —— provider 契约仍处 RC，0.3 不保证可用
- **Node** `>=22`（CI 在 22 与 24 上均全绿；Linux 亦通过）

## 已知限制

- CLI 是一次性执行，不能多轮追问；协作只能靠 DSH 侧编排
- 简报质量决定成败：太泛会让 CLI 到处探索（实测一次 193s / 46 万 token）
- 内置价目来自某个中转站的渠道价，**换站必须用 `config.pricing` 覆盖**
- macOS 未实测；真实 CLI 进程终止目前只在 Windows 观察过

## 验证

- 156 个用例：155 过 + 1 跳过（POSIX-only 用例在 Windows 上跳过）
- CI 三 job 全绿：Windows/Node 24、Windows/Node 22、Ubuntu/Node 24

## 安装

```bash
dsh plugin add dsh-subagent-native
```

装完去 设置 → 子代理，打开「允许模型调用」或「框架派发」才开始工作。
