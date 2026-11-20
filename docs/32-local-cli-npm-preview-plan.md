# 本机代理与 npm 内测方案

2026-11-20。用户回复“可以的”，确认先验证 Codex、同一候选的 npm 下载，以及 Claude Code 的现有网关路径。此前的独立云端测试继续暂缓。

| 决策 | 本轮范围 |
|---|---|
| D1 | 先在 macOS ARM64 验证 `axi --agent codex --file FILE`。使用本机 Codex 进程和其已有登录。候选每次复制一个已存在的项目 UTF-8 文件到临时 Git 目录。 |
| D2 | 每轮以原文件当前字节建立副本。进程在副本内工作。Axi 展示原项目的 diff，通过后才调用已有的原子提交。拒绝、中止和文件版本过期时保留原文件。 |
| D3 | 接收 Codex App Server 的逐行 JSON 事件。中断须以当前轮的终态为准。终端再次输入可继续同一会话。Trace 留在本机。 |
| D4 | npm 内测包携带同一冻结的 Bun 独立二进制与 Node 启动入口。新目录、独立 npm 缓存、无 Bun 的 PATH 用于本机复验。若有独立干净 Mac，则用其复验下载。公开发布须另行确认。 |
| D5 | 用同一任务及原项目保护条件复验已配置网关的 Claude Code。订阅、五个云端预设和跨进程会话持久化另行验收。 |

通过条件为真实修复、一次明确拒绝、批准后独立测试、一次中止后的续问。校验用户原有改动、Git HEAD、索引和非目标文件。npm 包验证版本、下载路径与登录复用。记录使用的实际平台与构建件。[Codex App Server](https://learn.chatgpt.com/docs/app-server) · [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/)
