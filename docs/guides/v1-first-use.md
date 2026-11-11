# v1 本机试用

当前实施分支为 `codex/v1-tools`。文件工具、权限和中断已实现；整体交付状态以[进度](../progress.md)与验证报告为准。用户手动试用是可选项，自动验收不依赖你完成以下操作。

## 启动一个独立练习目录

在 macOS 终端逐行执行。`mktemp` 创建新目录，不覆盖旧试用结果。

```sh
axi_trial=$(mktemp -d /tmp/axi-v1.XXXXXX)
cp /Users/spidey0o0zheng/workspace/axi/examples/v0-first-use/brief.md "$axi_trial/"
cp /Users/spidey0o0zheng/workspace/axi/examples/v0-first-use/tasks.md "$axi_trial/"
cd "$axi_trial"
bun --env-file=/Users/spidey0o0zheng/workspace/axi/.env run /Users/spidey0o0zheng/workspace/axi/src/main.ts
```

本机已有 Bun 与项目依赖。命令假设仓库 `.env` 已配置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY`；也可由终端环境提供。新电脑先在仓库运行 `bun install --frozen-lockfile`。不要把凭据粘贴到聊天或提交到 Git。

启动后，Axi 显示固定项目根目录和权限模式。等到 `你 [medium] >` 出现再输入一行任务。练习目录不是操作系统沙箱。

## 观察读取、修改和停止

| 顺序 | 输入或操作 | 应观察到的行为 |
|---|---|---|
| 1 | `用 glob 查找 Markdown 文件，再用 read 阅读 brief.md 和 tasks.md，先不要修改。` | 默认 project 模式自动读取，显示路径；不要求你逐次确认 |
| 2 | `/permissions strict`，再要求重新读取一个文件 | 本次读取需要单独确认；输入 `y` 才执行 |
| 3 | `/permissions project`，再输入 `按 brief.md 创建 stats.ts。先用 write 创建，再用 bash 运行 bun run stats.ts tasks.md。` | 新建先展示完整差异；运行命令另行确认 |
| 4 | `先 read stats.ts，再用 edit 增加任务总数和一位小数完成率。` | 展示本次差异；版本和唯一匹配有效才允许修改 |
| 5 | 在某次确认处输入 `n` 或直接回车，可填写拒绝理由 | 当前调用不执行；后续其他修改仍须各自确认 |
| 6 | 在运行期间按 Ctrl+C | 停止本轮，保留已完成修改，回到输入框；不会自动请求模型总结 |
| 7 | 输入 `继续检查现有文件并运行验证。` | 用本次会话已有历史继续；命令仍单独确认 |

练习完成后可在终端独立运行 `bun run stats.ts tasks.md`。预期三项状态为 3、1、2，总数 6、完成率 33.3%。结果取决于模型实际实现，不能仅用 Axi 的口头报告代替检查。

每次 `y` 只批准当前调用。不要提前粘贴一串 `y`。模式切换只在用户输入框生效，新启动恢复 project。`/permissions` 查看当前模式；`/help` 查看帮助；`/exit` 退出。

## 本阶段边界

- read/write/edit 处理根目录内不超过 1 MiB 的普通 UTF-8 文本。read 提供全文件版本；edit 只允许唯一精确替换。write 不覆盖已有文件，不自动创建父目录。
- grep 是区分大小写的字面量搜索。glob/grep 默认排除依赖、构建、凭据和内部日志目录；到上限会说明不完整。这不是完整 `.gitignore` 解释器。
- 文件工具拒绝符号链接、特殊文件、多硬链接及保留路径。默认自动读取不会授权文件修改或 bash。
- 用户确认后的 bash 保留宿主用户权限。建目录、大改写、删除等仍可以由 bash 提出，须检查完整命令后决定。
- 确认期间文件变化会使旧 edit 失效。最终检查与替换间仍可能发生不配合的外部写入；不支持多个编辑者持续竞争写同一文件。
- Ctrl+C 不自动撤销已完成操作。退出后不恢复会话。提交状态未知或关键日志失败时，Axi 停止后续工作并提示核对现场。

原生会话记录在练习目录 `.axi/logs/`，权限为 0600。日志包含请求、响应、工具、自动授权或人工确认、提案与提交状态，可能包含文件内容。它不会自动上传；认证头和服务端未返回的内部推理不在记录范围内。
