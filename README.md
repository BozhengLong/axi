# Axi

从零手写的终端 coding agent。不用官方 SDK，也不用 agent 框架。

当前分支已实现 v1 文件工具、权限与中断。确定性验证与两道已知回归通过，完整三方对照尚未完成；见[阶段报告](docs/verification/2026-11-12-v1-results.md)。使用 Bun + TypeScript，手写 HTTP 请求、SSE 解析和工具循环。默认模型为 `claude-opus-5-5`。

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
| read / glob / grep | 默认 project 模式自动读取经过校验的普通项目文件 |
| write / edit | 每次展示完整文件差异，输入 `y` 才应用 |
| `/permissions project`、`/permissions strict` | 切换自动读取或全部逐次确认；`/permissions` 查看模式 |
| bash 确认 | 展示完整命令和工作目录；输入 `y` 才执行本次调用 |
| 输入 `n` 或回车 | 拒绝当前调用，然后可填写理由；再次回车跳过理由 |
| `/effort medium` | 下一轮使用 medium，默认值 |
| `/effort high` | 下一轮使用 high；同一任务中的工具循环保持该档位 |
| `/help`、`/exit` | 查看帮助、退出 |
| Ctrl+C | 停止当前轮，保留已完成修改，然后回到输入提示 |

API 返回思考摘要时，界面显示“思考摘要”标签。有颜色的终端使用灰色。摘要语言由 API 返回内容决定。界面不会翻译或修改原始块。

当前只支持单行输入。请在提示出现后输入。多行粘贴中的后续行会被丢弃，不能用来预先批准未来调用。

## 边界

- Axi 没有操作系统沙箱。确认后的命令具有当前系统用户的权限，可以操作工作目录之外的文件。
- 每次调用使用新 shell，不能沿用 `cd` 或 `export`。不支持交互程序和后台任务。
- bash 默认超时为 120 秒，可指定 1 至 600000 毫秒。超时或中断会终止同一进程组；已经完成的文件修改不会撤销。
- 输出超过 30000 个 Unicode 字符时，保留头尾，并说明省略数量。stdout 和 stderr 合并展示，不保证跨流的精确顺序。
- 每轮最多调用模型 50 次。每次 HTTP 请求超时为 5 分钟。临时错误最多重试 3 次。
- 流中断或工具参数不是完整 JSON 时，不执行工具，不追加半截 assistant 消息。工具 JSON 错误不会自动重试，用户可以重新提出任务。
- 文件工具处理最多 1 MiB 的普通 UTF-8 文本。edit 需要有效读取版本与唯一匹配；write 只创建新文件。grep 是字面量搜索。路径、预览和并发保证见 [v1 设计](docs/07-v1-design.md)。
- 退出后不恢复会话。持久 shell、上下文压缩和会话恢复属于后续版本。

本机快速体验见 [v1 试用指南](docs/guides/v1-first-use.md)。

## 日志与验证

原始请求体、SSE 行、工具结果、确认记录和耗时保存在工作目录的 `.axi/logs/`。日志不记录认证头，但可能包含任务文本、文件内容和命令输出。Axi 在该目录内维护 `.gitignore`，使日志在其他 Git 仓库中运行时也默认被忽略；不修改项目根目录的忽略规则。忽略规则不会移除已跟踪的文件，也不能阻止强制添加。日志文件权限为 `0600`。

日志默认开启，每次交互启动创建一个 JSONL 文件，启动画面显示绝对路径。退出后保留，但目前不支持凭日志恢复会话。日常日志的内容、输出截断和评测证据包的区别见[日常 Trace 指南](docs/guides/daily-trace.md)。

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
- 自动评测与 Trace：[docs/guides/automated-evaluation.md](docs/guides/automated-evaluation.md)、[docs/guides/trace-reading.md](docs/guides/trace-reading.md)
- 复杂任务对照：[运行方法](docs/guides/complex-evaluation.md)、[2026-11-11 结果与补充复验](docs/verification/2026-11-11-complex-comparison.md)
- 真实仓库连续任务：[C6 运行与复验](docs/guides/c6-evaluation.md)、[对照结果](docs/verification/2026-11-11-c6-comparison.md)
- 缺陷修复对照：[C7 设计](docs/06-c7-repair-evaluation-design.md)、[运行与复查](docs/guides/c7-evaluation.md)、[对照结果](docs/verification/2026-11-11-c7-comparison.md)
- v1 当前结果：[阶段报告](docs/verification/2026-11-12-v1-results.md)、[逐次数据](docs/verification/2026-11-12-v1-results.json)、[待确认补全方案](docs/08-v1-evaluation-completion-plan.md)
- v1 已确认方案：[文件工具、权限与中断设计](docs/07-v1-design.md)、[自动验收矩阵](evals/specs/v1-tools-v1/acceptance-matrix.md)（产品已实现，完整评测未通过，完成范围见阶段报告）

评测原始 Trace 与历史镜像保存在本机私有目录，不随源码发布。报告中的本机绝对路径只在原机器可用；部分 C6 复验入口依赖这些历史产物，具体条件见对应运行指南。

有界收尾复核的开关、预算与Trace范围见[使用说明](docs/guides/bounded-review.md)。功能实现不代表已通过v1发布验收，当前状态见[进度](docs/progress.md)。
