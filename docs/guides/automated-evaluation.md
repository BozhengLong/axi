# 自动测试与同题对照的运行方法

本流程依据已确认的[评测设计](../02-evaluation-design.md)。它使用真实模型，会自动批准隔离测试环境内符合规则的操作。不要将实际业务文件替换进虚构任务目录。

## 运行条件

- Docker Desktop 服务已启动。镜像构建需要网络和磁盘空间。
- 当前终端已设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY`。控制器将它们交给独立转发服务，任务容器只得到本轮临时凭据。
- 在 Axi 仓库根目录运行。先结束上一批资源，再初始化新批次；不要并行启动两批正式测试。

## 完整顺序

```sh
cd /Users/spidey0o0zheng/workspace/axi
docker build -t axi-eval:20261110 -f evals/environment/Dockerfile .
bun run scripts/eval/core.ts init
bun run scripts/eval/preflight.ts --live
bun run scripts/eval/known-regressions.ts
bun run scripts/eval/run.ts --live
bun run scripts/eval/trace.ts
bun run scripts/eval/core.ts cleanup
```

逐条执行，上一条成功后才继续。`preflight.ts` 失败时不要执行正式运行。`run.ts` 也会检查前置结果和镜像标识。

前置检查包含真实模型的简单写运行任务。正式对照为 4 类任务各重复 3 次，两边共 24 个运行，模型 HTTP 请求数会更多。R1–R3 的专项用于记录既有缺陷；`defectReproduced: true` 表示缺陷仍存在，不是功能验收通过。

## 结果位置

控制器输出批次 ID，证据保存在 `~/.local/share/axi-evals/<batch-id>/`：

| 文件 | 内容 |
|---|---|
| `preflight.json` | 前置检查结果、镜像和是否包含真实检查 |
| `manifest.json` | 固定顺序、任务原话、模型设置与源文件哈希 |
| `results.json` | 所有已完成正式样本与独立验收结果 |
| `completion.json` | 是否完成 24 个运行 |
| `<运行 ID>/` | CLI 输出、各轮快照和最终产物 |
| `relay/<运行 ID>.jsonl` | 请求、响应和权限记录，不包含真实认证头 |
| `known-regressions.json` | R1–R3 的复现情况 |
| `TRACE-INDEX.md` | 按任务和工具查看详细运行记录 |
| `<运行 ID>/trace-manifest.json` | Trace 完整性状态及逐文件校验值 |
| `<运行 ID>/native/` | 清理容器前导出的原生会话日志 |
| `source-snapshot/` | 本批实际使用的源码和测试副本 |

目录中还包含控制通道的私有状态，不应整体上传或提交。正式共享使用仓库内的脱敏报告。

## 中断与恢复

先运行 `bun run scripts/eval/core.ts cleanup`，它只清理当前批次标签下的容器和网络，不删除证据、不清理其他 Docker 项目。

如果源码、题面或验收器改变，需要新建批次。不要把改变前后的样本放进同一批。正式脚本可以跳过已有结果，但不自动修复控制器异常或删除失败；环境故障补跑必须按设计保留原记录并明确标记。

正式结果中的成功率由独立验收决定。CLI 退出码为 0 或回复“完成”，都不等于任务通过。

Trace 的内容、版本 1 的历史缺口及版本 2 的收取范围见[运行轨迹指南](trace-reading.md)。
