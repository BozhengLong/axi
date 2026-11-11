# 复杂任务评测运行方法

本流程实施已确认的 [COMPLEX/D1–D4](../04-complex-evaluation-design.md)，使用真实模型。两边的自动授权仅适用于隔离任务环境。真实凭据只进入独立模型转发服务。

## 任务和验收

首批任务为 `C1` 订单并发、`C2` 数据迁移、`C4` Axi 离线回放。代码在 `evals/complex-v1/<任务>/`：

- `seed/`：两边收到的相同起点。`.fixture` 后缀在投递时移除；SQLite 保留原字节。
- `reference/`：控制器侧的正确参考改动，不投递给 agent。
- `oracle/`：候选运行结束后，在另一个无网络容器执行的行为探针。

控制器侧比较结果。候选不能读取参考实现或独立验收输入。原测试及配置受保护；候选可以新增测试，不能弱化已有要求。严格类型检查、原测试、兼容性和数据完整性均计入硬条件。

校准需要同时满足：初始项目可编译且旧测试通过；参考实现全通过；每题两个错误变体在正常编译及旧测试通过的情况下被行为验收拒绝。校准失败时不能开始真实对照。

## 准备与执行

先确认没有另一批测试正在运行。以下命令逐条执行，前一条失败就先查原因。

```sh
cd /Users/spidey0o0zheng/workspace/axi
docker build -t axi-eval-complex:20261111 -f evals/environment/Dockerfile.complex .
AXI_EVAL_IMAGE=axi-eval-complex:20261111 bun scripts/eval/core.ts init
bun scripts/eval/preflight.ts --live --complex
bun scripts/eval/complex/calibrate.ts
AXI_EVAL_DEADLINE="<本次 UTC ISO 截止时间>" bun scripts/eval/complex/run.ts --live
```

复杂镜像继承已冻结的 `axi-eval:20261110`，不重建或修改被测 Axi。在更换产品版本时，应另建镜像和实验组，核对 `/opt/axi/src` 与目标源码哈希。

默认运行 6 个试跑。试跑后先复盘任务与控制器，再建立新批次，重新执行前置检查和校准，使用下列命令执行 18 个正式运行：

```sh
AXI_EVAL_DEADLINE="<本次 UTC ISO 截止时间>" bun scripts/eval/complex/run.ts --live --formal
```

试跑与正式结果分别保存，不混合计算成功率。每次最多 30 分钟、50 次模型 HTTP 请求；请求预算包含实际重试。原生 Axi 循环上限保持不变。

`AXI_EVAL_DEADLINE` 必须明确设置本次工作的 UTC ISO 截止时间。控制器在一对新运行开始前检查时间，预留配对的最大运行时间与至少 30 分钟报告时间。截止时间不足时只停止新配对，不删除已完成结果。

## 留证与清理

证据位置沿用 `~/.local/share/axi-evals/<批次>/`，私有目录与文件权限分别为 0700 和 0600。

- `complex-calibration.json`：参考与错误变体的校准结果。
- `manifest.json`：任务、固定交替顺序、模型、预算、源码哈希。
- `source-snapshot/`：本批源码、题目与验收器快照。
- `<运行>/verification.json`：类型检查、原测试、独立探针的原始输出。
- `<运行>/execution.json`、`final-files.json`：执行结果和全部候选文件。
- `<运行>/TRACE.md`、`trace-manifest.json`：IO、原生会话、API 记录与完整性校验。
- `results.json`、`completion.json`：样本结果和是否跑完计划数量。

```sh
bun scripts/eval/trace.ts
bun scripts/eval/core.ts cleanup
```

清理只回收当前批次容器和网络，不删除 Trace。发生测试设施问题时保留旧批次，记录原因，修订后新建批次。普通任务失败如实计入结果，不以修复候选文件或反复抽样替换失败。

## 环境故障的单次配对补跑

原设计只允许环境恢复后额外补跑一次完整配对。先核对原始 API/CLI 证据，把环境不可判定的原因写入原批次 `incident.json`；不能用此入口替换普通任务失败。

回收原批次后，创建相同镜像的新批次，重新通过前置检查和校准，再运行：

```sh
AXI_EVAL_DEADLINE="<本次 UTC ISO 截止时间>" bun scripts/eval/complex/continue.ts --live --from <原批次 ID>
```

调度器保留事故前完整配对的全部结果，对受影响配对双方使用 `retry1` 标记并从相同种子重做，然后执行剩余计划。原结果不覆盖。同一事故只能指定一个恢复批次。

续跑会核对原有全部源文件和镜像完全一致，只允许新增恢复调度器及其回归文件。汇总时分别列出计划数、实际启动数、有效样本数和环境不可判定数，不把补跑藏在成功率中。

## 当前验收版本与补充检查

2026-11-11 的正式成绩使用 revision 2。随后发现 C1 故障钩子异常类型边界遗漏，当前代码已升级到 revision 3，并修正参考实现。复现历史成绩时，使用对应批次的 `source-snapshot/`，不要用当前规则改写旧分数。

离线验证参考实现、错误变体和本轮六份已保存 C1 产物：

```sh
bun scripts/eval/complex/validate-revision.ts
```

该脚本目前针对本轮 `complex-20261111` 证据，不发模型请求。运行前需要已有评测镜像和本轮产物。

任务结束识别的针对性回归：

```sh
AXI_EVAL_IMAGE=axi-eval-complex:20261111 bun scripts/eval/complex/check-completion.ts
```

这两个场景使用真实 Axi CLI 与模拟 API，不发真实模型请求。相同的错误场景已加入常规 preflight。原始 HTTP 响应也会进入传输摘要，避免漏记普通 HTTP 429。主批次实际执行的前置数量见其 manifest，不能用后来增加的检查数覆盖旧记录。
