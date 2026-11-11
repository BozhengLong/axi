# v1 自动验证与证据入口

本阶段依据 [v1/D1–D7](../07-v1-design.md)，使用 `codex/v1-tools`。用户已授权确定性验证、2 次 C7 已知回归、两道新任务三方各 3 次比较。正式最多 23 次，其中只有一组三方环境补跑；不能为普通失败重抽样。

## 三层验证

1. 产品门槛：`bun run typecheck`、`bun test`；macOS 与固定 Linux 镜像的真实文件/进程/终端检查，以及六种产品错误变体。详见[矩阵](../../evals/specs/v1-tools-v1/acceptance-matrix.md)。
2. 评测环境：9 项交互模拟、26 项完整前置（含三种 CLI 的真实短任务）和任务全流水线模拟。检查实际预览、输入/Git 初态、模型、隔离、交付识别、独立验收与 Trace。前置短任务不计能力样本。
3. 固定任务：C7 两题只运行新 Axi 各一次；新题 [V1-A/V1-B](../../evals/specs/v1-holdout-v1/README.md) 对旧 Axi、新 Axi、Claude Code 各运行三次。代码、有效回归、报告真实性分开判断。

新 Axi 固定产品提交 `0bde765`（产品源码与 `7827eaa` 相同）；旧 Axi 固定 `963704b`。同一镜像包含两套入口和 Claude Code 2.1.322，Bun 1.3.14，模型 `claude-opus-5-5`，effort=medium。候选镜像 digest：

```text
sha256:89533abd22cabe73692800a8b7a48ea0849edc6fddd8435cd85898d7938f21cf
```

每次全新会话、HOME、容器和工作卷；2 CPU/4 GiB，工作卷上限 2 GiB 每 10 秒监测，宿主保留 4 GiB。依赖只读；无公网、宿主目录或 Docker socket。真实凭据只在模型转发器。验收容器无网络。这些隔离来自评测设施，不能等同于 Axi 自身提供沙箱。

## 本机证据

研究目录为 `~/.local/share/axi-evals/v1-20261112/`。

| 文件 | 内容 |
|---|---|
| product-freeze.json | 产品提交、逐文件指纹、固定镜像和前置来源 |
| mutations-latest.json | 产品错误变体校准目录 |
| smoke-latest.json | 9 项交互模拟；原失败批次单列保留 |
| preflight-latest.json | 26 项前置与 3 次真实接入探针 |
| tasks/A、tasks/B | 上游来源、输入、依赖锁文件和清单；准备修订留旧版 |
| calibration-latest.json | 两道新题与 C7 的 14 项校准 |
| pipeline-smoke-latest.json | 新旧 Axi/Claude 共 8 次完整流水线模拟 |
| formal-batch.json、formal.claim | 首批位置与一次性绝对截止；首批因公开命令缺陷停止 |
| continuation-batch.json、continuation.claim | 同一截止与累计预算下的修订批次；原受影响样本不混入比较 |
| RUNNING.md | 当前私有执行检查点 |

批次目录中保存 manifest/source-snapshot、attempts/results/selection、每次 initial/final 文件与 Git 状态、verification、终端/输入输出时间线、API 事件、原生会话日志和 SHA-256 清单。对照报告审查写在单独文件，原始机判和 Trace 不覆盖。参见[Trace 说明](trace-reading.md)。

完整 Trace 指方案约定的可观察记录。它包含 API 返回的思考摘要，不能包含服务端未返回的内部推理。文件工具和 bash 自身的输出上限仍适用；原生记录与保留快照可用于核对实际落盘结果。

## 执行入口

以下命令是复查入口，不会在普通 `bun test` 时启动真实模型。必须具备上述私有输入、历史 C7 归档、固定镜像与依赖卷。

```sh
bun scripts/verify-v1-mutations.ts
AXI_EVAL_IMAGE=sha256:89533abd22cabe73692800a8b7a48ea0849edc6fddd8435cd85898d7938f21cf bun scripts/eval/v1/run.ts --check
```

正式启动使用同一命令的 `--live`。控制器用一次性 formal.claim 阻止重复启动，自动固定最多 18 小时截止并预留 30 分钟报告；不能删除 claim 绕过预算。只读 `--check` 校验产品、前置、校准、模拟和输入指纹，不启动模型。新任务只能在新的产品冻结和授权计划中替换。

自动控制器按冻结策略响应确认，它的响应时间不是人的思考时间。真实用户的易用性反馈仍可通过[v1 试用](v1-first-use.md)单列收集。

## 公开命令修复后的续跑

首批因公开 AVA 命令误收集新测试而停止。详情见[任务规格修订](../../evals/specs/v1-holdout-v1/README.md#公开命令修订设施-revision-2)和[日报](../devlog/2026-11-12.md)。重新冻结使用 AXI_V1_CONTINUE_FROM 指向原批次。控制器只接受已完整交付的固定四条记录、同一产品/镜像/截止，以及仅公开命令的输入差异；复用 C7 两条，排除原首组两条。之后执行原六组三方计划，累计预计 22 次，且关闭进一步恢复。不能用该入口重跑普通失败。

## 当前收尾状态

首批4次、修订批次2次，共6次正式启动。修订批次因连接异常与观察器提前中断重试停止，0个完整三方组。见[结果](../verification/2026-11-12-v1-results.md)。4077146已离线修复观察器，新验证镜像与传输模拟单列；没有用于原样本。

smoke-before-transport.json保留正式运行前的9项模拟入口；smoke-latest.json现指向设施修复后的9项交互回归，transport-smoke-latest.json指向7项传输模拟。正式批次manifest保存当时准确来源，不能拿最新指针替换旧证据。evidence-formal-close.json记录正式结束时的指纹与85文件校验。

当前源码的运行器已经改变，旧study的正式启动检查应拒绝继续。下一轮只有在[新预算方案](../08-v1-evaluation-completion-plan.md)确认后才能建立，不能通过改product-freeze或删除claim绕过。
