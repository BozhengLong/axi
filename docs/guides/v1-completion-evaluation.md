# v1 固定题复验

用户已确认[补全D1–D3](../08-v1-evaluation-completion-plan.md)。本轮研究目录为 `~/.local/share/axi-evals/v1-completion-20261112/`，旧轮 `v1-20261112/` 保持原样。产品源码冻结于0bde765，模型claude-opus-5-5、effort=medium，CLI版本与依赖不升级。

## 预算和隔离

- 两题 × 旧Axi/新Axi/Claude Code × 三次，共18次。仅上游环境不可判定时允许完整三方补跑一次，最多21次新正式启动；普通失败保留。
- 北京时间2026-11-12 02:55:54至20:55:54，包含准备、探针和报告；最后30分钟留作报告。三方组需至少180分钟剩余窗口。
- 每次30分钟/最多50次转发生成请求；超预算的本地尝试另记，不把未转发请求算作模型调用。独立验收15分钟。
- 每次新容器、HOME、工作卷；2 CPU/4 GiB；工作卷2 GiB每10秒检查，宿主保留4 GiB。依赖只读，无公网、宿主目录和Docker socket；独立验收无网络。
- 固定镜像：`sha256:5d82c0e27b4d9eeab57ab7b000f03526e1326685ba6f272cf9ed00d244ee6007`。

## 前置与正式入口

研究目录的run-env.sh只设置研究目录和固定镜像，不含真实凭据。当前机器执行：

```sh
source /Users/spidey0o0zheng/.local/share/axi-evals/v1-completion-20261112/run-env.sh
bun scripts/eval/v1/calibrate.ts
bun scripts/eval/v1/pipeline-smoke.ts
bun scripts/eval/v1/smoke.ts
bun scripts/eval/v1/transport-smoke.ts
bun scripts/eval/v1/preflight.ts --live
bun scripts/eval/v1/completion-run.ts --check
```

这些是复查入口，不应不看现状就重复执行。校准/模拟/前置的最新指针会变化，原批次快照仍保留。preflight的3个真实接入任务单列，不计能力样本。正式启动使用completion-run.ts --live；一次性formal.claim阻止重复启动。

新调度器要求所有前置与当前完整源码指纹相同。正式运行中再次核对源码、任务字节及同题Git初态。任何设施/输入/判定规则问题停止本轮，不能边改验收边计成绩。执行器终止或来源不明137/143退出记为不可判定，普通断言/编译错误照常判失败。所有已有原始结果不得覆盖。

## 证据与判读

authorization.json记录用户确认与截止；任务输入及衍生关系在tasks/A、tasks/B。题面、参考、保留验收与上一轮相同，仅环境说明补充可选lint只读缓存限制。两题属于固定题复验，不称独立盲测。

formal-batch.json指向本轮批次，包含manifest/source-snapshot、attempts/results/selection/completion、各次CLI输入输出、原生日志、API事件、文件/Git快照及验收。codePassed与regressionPassed是机判；最终说明和回归含义另行审查后才判断完整交付。

旧轮两道C7作为相同产品的已知回归单列；旧轮零散新题不混入本轮对照。比较按完整三方组采用。时间、用量和权限次数只报告本批观察，不据此给产品总体排名，也不把控制器的确认时间当成人的思考时间。
