# Axi：愿景与工作方式

## 一句话

从零手写一个终端里的 coding agent（对标 Claude Code / Codex CLI / opencode），**目的是吃透 agent 背后的工程细节，同时做成自己能日常用的工具**。

## 两个目标，一个约束

- **学习**：每个阶段都要搞清楚"为什么这么做"，以及"不这么做会怎样"。
- **实用**：不追求替代 Claude Code。约束是：**每个阶段结束时必须能跑、并且真的拿它干点活**（dogfooding）。
- 后期找一个 Claude Code 做得不好、而我们自己需要的点，作为差异化。

## "从零"的边界

| 用 | 不用 |
|---|---|
| Bun 运行时、TypeScript、Bun 内置 API（`fetch`、`Bun.spawn`、`Bun.file`） | Anthropic 官方 SDK |
| 必要时用小型工具库（例如终端颜色），用前写明理由 | LangChain / Vercel AI SDK / Claude Agent SDK 等任何 agent 框架 |
| | 现成的 SSE 解析库 |

协议层（HTTP、SSE、消息拼装）全部手写，这是第一批要吃透的工程细节。

## 分工

| 角色 | 负责 |
|---|---|
| 用户（PM） | 拍板产品决策：什么时候打断用户、怎么展示、出错怎么说、上下文满了丢什么；每阶段做实验、dogfood、提反馈 |
| Claude | 每阶段先写设计文档（选项 + 取舍 + 推荐）→ 用户拍板 → 实现 → 关键代码加中文注释 → 设计实验 |

设计文档里的决策点统一用 **D1、D2……** 编号，方便回复。

## 路线图

| 阶段 | 能做什么 | 主要学到的东西 |
|---|---|---|
| **v0 最小循环** | 多轮对话；模型能调用 bash（每条命令都要确认） | HTTP + SSE 手写解析、流式拼装 content block、tool_use 循环、stop_reason、thinking 块回传 |
| **v1 能干活** | read / write / edit / grep / glob 工具；权限规则；中断（Ctrl+C） | 工具 schema 设计、edit 的几种策略、输出截断、权限模型、取消与状态清理 |
| **v2 能长跑** | 会话保存与恢复；prompt caching；上下文压缩；项目记忆文件（AXI.md） | token 预算、缓存前缀稳定性、压缩策略、append-only 历史 |
| **v3 体验** | 真正的 TUI（流式 markdown、diff 预览）；slash command | 终端渲染、输入编辑、交互设计 |
| **v4 扩展** | subagent、MCP client、hooks、沙箱 | 多 agent 上下文隔离、协议对接、进程隔离 |
| **贯穿** | 每轮打印 token 与缓存命中；原始请求/响应日志；小型 eval 集 | 可观测性；怎么判断 agent 变好了还是变差了 |

## 环境事实

- API 走公司网关：`ANTHROPIC_BASE_URL`（内网 HTTP），`ANTHROPIC_API_KEY` 用 `x-api-key` 头。2026-10-12 已验证普通请求和 SSE 流式都能直通。
- 额度充足，开发时直接用 `claude-opus-5-5`，不为省钱降级模型。
