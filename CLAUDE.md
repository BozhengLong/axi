# Axi

从零手写的终端 coding agent（对标 Claude Code / Codex CLI / opencode），兼顾学习和实用。愿景与路线图见 `docs/00-vision.md`，各阶段设计见 `docs/NN-*.md`。

**新会话开始时先读 `docs/progress.md`**，里面有协作须知、已定决策、当前状态和下一步。每次会话结束前更新它。

同时遵守 [AGENTS.md](AGENTS.md) 中的共用规范。正式记录和 commit 说明使用中文，采用 STE 的清晰表达原则。有实质进展时，追加开发日报。

## 硬约束

- **不用 Anthropic 官方 SDK，也不用任何 agent 框架。** 直接 `fetch` 调 `POST $ANTHROPIC_BASE_URL/v1/messages`，SSE 手写解析。这是项目的核心学习目标，不是疏忽。
- API 地址和 key 从环境变量 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` 读取（公司网关，`x-api-key` 头 + `anthropic-version: 2023-06-01`）。
- 默认模型 `claude-opus-5-5`：使用 adaptive thinking。返回 thinking 块时，保留原文与签名；不使用 `tool_choice` 的 `any`/`tool`。
- **对话历史只追加不修改**（append-only）。这是项目约束，用于保留原始消息及工具配对。2026-10-12 的网关实验未因删除 thinking 块而报错，不能声称删除一定导致 API 失败。实验记录见开发日报。

## 工作方式

- 用户是产品经理，代码由 Claude 写。每个阶段先写设计文档（决策点编号 D1、D2……），用户拍板后再实现。
- 文档和代码注释用中文；标识符用英文。关键逻辑要有注释，讲清楚"为什么"。
- 每个阶段结束时必须能跑，配套实验写在设计文档里。

## 运行时

- 用 Bun：`bun run`、`bun test`、`Bun.spawn`、`Bun.file`。不用 Node 专属工具链。
- 新增依赖前先说明理由。
