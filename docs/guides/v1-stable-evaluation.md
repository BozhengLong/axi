# 稳定环境中的 v1 对照与评分重放

本轮依据已确认的[稳定化D1–D5](../09-v1-environment-stability-plan.md)。私有研究目录为`~/.local/share/axi-evals/v1-stable-20261112/`。授权起点为北京时间2026-11-12 16:37:06，截止为2026-11-13 10:37:06；报告预留30分钟。最多21次正式启动、6次真实探针、一次评分恢复及一次上游整组三方恢复。

## 固定环境

Node 22.23.5官方linux-arm64安装包已按官方SHASUMS256核对。原基础镜像为`5d82c0e`，新镜像完整ID见私有authorization.json与node-origin.json。Bun、Claude、npm、pnpm和TypeScript版本保持；Claude实测为本机架构ELF可执行文件，不依赖Node脚本解释器。两题仅更改公开环境说明中的Node版本。

执行脚本前需要设置当前研究目录、两个相同的固定镜像ID以及`AXI_V1_NODE_PROFILE=node22`。本机可加载研究目录的run-env.sh；它不包含真实凭据。旧轮入口的默认Node24行为保留，不用新参数重写旧成绩。

## 前置与正式执行

所有命令从Axi仓库运行。以下是明确区分的入口，不应在已有claim后重复执行真实探针或正式启动：

| 入口 | 内容 |
|---|---|
| `bun scripts/eval/stable/setup.ts --offline` | 核对镜像/二进制，转换新研究的任务环境说明；不可重复覆盖输入 |
| `bun scripts/eval/stable/stability.ts --compatibility` | 两题版本、依赖树和公开命令检查 |
| `bun scripts/eval/stable/stability.ts --offline` | 200次正反类型、120次公开命令重复检查 |
| `bun scripts/eval/v1/calibrate.ts` | 14项评分校准 |
| `bun scripts/eval/stable/c7-replay.ts --offline` | 两份历史C7产物的离线回归，不调用模型 |
| `bun scripts/eval/stable/pipeline.ts --mock` | 三遍、共24次真实CLI配合模拟转发器的完整流程 |
| 原v1交互/传输模拟入口 | 9项交互和7项传输回归 |
| `bun scripts/eval/stable/recovery-checks.ts --mock` | 6项评分异常与恢复规则检查，不调用真实模型 |
| `bun scripts/eval/stable/preflight.ts --live` | 通过全部离线门槛后，最多一次初始三方真实接入；claim预留3次探针 |
| `bun scripts/eval/stable/run.ts --check` | 只读核对全部门槛与冻结指纹 |
| `bun scripts/eval/stable/run.ts --live` | 写入一次性正式claim，执行固定六组三方 |

setup的早期兼容验证不代替最终门槛。正式启动要求所有门槛与当前完整源码一致。源码、题面、镜像、模型、权限、顺序与预算都写入冻结记录。

## 执行证据与评分证据

- `state.json`：全研究的启动台账、执行清单、当前评分引用、采用组、恢复额度和阶段。可跨一次合法评分恢复保存多个批次目录。
- 每个运行目录的`execution-seal.json`：输入、交付和最终文件、Git、原生Trace及API事件的校验值；记录执行profile与产物摘要。评分前后都复核，不写回候选产物。
- `grades/<graderRevision>/<运行ID>/`：该评分版本的attempt、原始评分日志和score。普通断言失败为评分完成但代码失败；评分设施异常为indeterminate，代码和回归结果为null。
- 原`execution.json`、`result.json`、Trace和文件快照保留。仅执行模式的机判状态为not_run，不用false代替尚未评分。
- `source-snapshot/`、manifest、authorization、node-origin及各项门槛报告提供来源和版本。

每个产物在同一评分目标目录及版本只允许一次尝试，已有目录不能覆盖。封存依赖哈希检测修改，不承诺抵抗拥有宿主文件权限的人主动篡改全部清单。

## 一次评分恢复

出现评分设施异常后，控制器停止新增模型任务，写入`phase=grade_repair_required`，清理当前转发器。用户已通过D3授权一次限定的离线修复和重放；不需要为该范围再次申请授权。

恢复必须由当前助手检查实际故障与改动。只有评分层变化、原执行profile和题目/验收规则不变，才能继续。重新通过14项正反校准和6项恢复检查后，形成grader-repair.json：旧/新评分版本、证据路径、reviewedBy=current-assistant、semanticsUnchanged=true。grader-epoch.json只能从0进入1；它区分操作性修复后的评分版本，不代替故障证据或规则审查。

运行`bun scripts/eval/stable/run.ts --resume`前，再核对完整执行证据、门槛和足够的重评时间。所有已完成产物都按固定顺序重评，包括此前通过和失败的样本；不启动这些样本的模型进程。普通断言失败如实保留。任何再次不可判定都停止；原机判和新评分同时保留。

涉及候选环境、执行控制器语义、任务契约或评分期望变化时，这个入口必须拒绝恢复。不得删除claim、清空台账、改起点或延长截止来绕过限制。

## 结果口径

同执行profile、同最终评分版本的完整三方组才能进入比较。人工另行核对代码、回归有效性和最终说明，机判通过不直接等于完整交付。

C7标记为历史模型执行加本轮离线检查；前两轮9个正式样本不混入新环境成绩。正式未结束前，以state和当前日报为准，不填写完成率或发布通过结论。
