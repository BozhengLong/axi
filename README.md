# Axi

从零手写的终端 coding agent。不用官方 SDK，也不用 agent 框架。

当前版本为 v0。使用 Bun + TypeScript，手写 HTTP 请求、SSE 解析和工具循环。默认模型为 `claude-opus-5-5`。

## 运行

需要 Bun。本项目在 macOS 和 Bun 1.3.14 上验证。

```sh
bun install --frozen-lockfile
export ANTHROPIC_BASE_URL="你的 API 网关根地址"
export ANTHROPIC_API_KEY="你的 API key"
bun run axi
```

也可以在本地 `.env` 中设置这两个变量。不要把凭据提交到 Git。地址可以使用根地址、`/v1` 地址或完整的 `/v1/messages` 地址。

在其他目录中启动时，使用入口文件的绝对路径：

```sh
bun run /你的路径/axi/src/main.ts
```

启动时的目录就是工具工作目录。可先输入“这个目录里有什么，总共多大？”，再提出后续任务。

## 使用规则

| 操作 | 行为 |
|---|---|
| 输入任务 | 完成后继续等待输入，保留本次运行中的历史 |
| bash 确认 | 展示完整命令和工作目录；输入 `y` 才执行本次调用 |
| 输入 `n` 或回车 | 拒绝命令，然后可填写理由；再次回车跳过理由 |
| `/effort medium` | 下一轮使用 medium，默认值 |
| `/effort high` | 下一轮使用 high；同一任务中的工具循环保持该档位 |
| `/help`、`/exit` | 查看帮助、退出 |
| Ctrl+C | 中止当前输入、请求或命令，然后回到输入提示 |

API 返回思考摘要时，界面显示“思考摘要”标签。有颜色的终端使用灰色。摘要语言由 API 返回内容决定。界面不会翻译或修改原始块。

v0 只支持单行输入。请在提示出现后输入。多行粘贴中的后续行会被丢弃，不能用来预先批准未来调用。

## 边界

- v0 没有沙箱。确认后的命令具有当前系统用户的权限，可以操作工作目录之外的文件。
- 每次调用使用新 shell，不能沿用 `cd` 或 `export`。不支持交互程序和后台任务。
- bash 默认超时为 120 秒，可指定 1 至 600000 毫秒。超时或中断会终止同一进程组；已经完成的文件修改不会撤销。
- 输出超过 30000 个 Unicode 字符时，保留头尾，并说明省略数量。stdout 和 stderr 合并展示，不保证跨流的精确顺序。
- 每轮最多调用模型 50 次。每次 HTTP 请求超时为 5 分钟。临时错误最多重试 3 次。
- 流中断或工具参数不是完整 JSON 时，不执行工具，不追加半截 assistant 消息。工具 JSON 错误不会自动重试，用户可以重新提出任务。
- 退出后不恢复会话。文件工具、持久 shell、自动授权、上下文压缩和会话恢复属于后续版本。

## 日志与验证

原始请求体、SSE 行、工具结果、确认记录和耗时保存在工作目录的 `.axi/logs/`。日志不记录认证头，但可能包含任务文本、文件内容和命令输出。该目录已被项目的 Git 忽略规则排除。文件权限为 `0600`。

```sh
bun run typecheck
bun test
AXI_DEBUG=sse bun run axi
```

自动化测试使用本地模拟 API 和临时目录，不调用真实模型。日志中的 `activeMs` 是任务总耗时减去确认与理由输入的等待时间。

需要主动运行真实 API 实验时：

```sh
bun run scripts/experiments.ts --live
```

实验覆盖工具参数分片、三个目录的调用形式、effort 对比和删除思考块的对照。脚本只发送 API 请求，不执行模型提出的 bash 命令。结果保存在 `.axi/experiments/`，不随 `bun test` 运行。

## 项目记录
- 愿景与路线图：[docs/00-vision.md](docs/00-vision.md)
- v0 设计：[docs/01-v0-design.md](docs/01-v0-design.md)
- 当前状态：[docs/progress.md](docs/progress.md)
- 协作与记录规范：[AGENTS.md](AGENTS.md)
- 开发日报：[docs/devlog/](docs/devlog/)
