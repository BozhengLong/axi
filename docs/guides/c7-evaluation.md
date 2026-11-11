# C7 修复对照的运行与复查

设计与预算见 [C7/D1–D5](../06-c7-repair-evaluation-design.md)。本指南对应固定的 2026-11-11 研究。候选源产物和运行状态位于本机 `~/.local/share/axi-evals/c7-20261111/`，不随 Git 发布；新研究应另设目录和输入，不复用本批指针重新计分。

## 当前实现

- [输入组装](../../scripts/eval/c7/tasks.ts)核对 C7 起点归档，按明确清单移除历史控制材料和生成文件，不改业务代码。
- [故障报告生成](../../scripts/eval/c7/prepare.ts)在镜像中真实执行复现，把当前输入哈希和实际失败写入报告。输入哈希排除报告自身，最终快照另有完整哈希。
- [独立验收](../../scripts/eval/c7/grade.ts)复用 C6/C1 契约并增加 C7 复现和边界。保护原件、Git 初态和用户修改。
- [回归测试回放](../../scripts/eval/c7/regression.ts)将相同新增测试放到修复后和旧代码两个副本。记录 Jest JSON/Bun JUnit；编译、导入错误、空断言和 skip 不能冒充有效回归。
- [校准](../../scripts/eval/c7/calibrate.ts)包含两题各两次基线、两份参考、六个错误修复和六个无效测试，共 18 案例。代码及输入摘要与当前前置对应。
- [模拟流程](../../scripts/eval/c7/smoke.ts)使用真实 CLI 与模拟 API，覆盖两题双方交付，以及双方超时和后台进程终止，不计模型能力成绩。
- [正式调度](../../scripts/eval/c7/run.ts)执行固定六对，遵守预算、绝对截止和全批一次整对环境补跑上限。一次性 claim 阻止误启动第二批。

## 准备顺序

在仓库根目录运行。当前复用的固定镜像是 `sha256:92840cfa30671118f34ee7d60e412ef68b7c0a713d5e5ba01a52a490f0bdc8c6`，Listr2 的依赖卷为 `axi-c6-dependencies-20261111`。没有这些本机产物时，先按已有环境指南重建并重新冻结，不跳过验证。

```sh
bun run scripts/eval/c7/prepare.ts
bun run scripts/eval/c7/calibrate.ts
AXI_EVAL_IMAGE=sha256:92840cfa30671118f34ee7d60e412ef68b7c0a713d5e5ba01a52a490f0bdc8c6 bun run scripts/eval/c7/smoke.ts
```

控制器实现调整后，最终校准、模拟检查和完整 preflight 必须对应同一份源码指纹。模拟 API 不请求真实模型；以下完整前置包含明确的真实连通性检查：

```sh
AXI_EVAL_IMAGE=sha256:92840cfa30671118f34ee7d60e412ef68b7c0a713d5e5ba01a52a490f0bdc8c6 bun run scripts/eval/core.ts init
bun run scripts/eval/preflight.ts --complex --live
```

检查当前批次 preflight.json 的 complete/pass/live、全部检查和 image/sourceHash 后，才将其另存为研究目录的 preflight-approved.json。清理该前置批次的转发器，再开始正式批次。旧记录不覆盖。

## 正式执行

先完成准备设施的提交推送。启动前把明确的 `AXI_C7_DEADLINE` epoch 毫秒写入私有启动记录，并设置相同的 `AXI_EVAL_IMAGE` digest。运行 `bun run scripts/eval/c7/run.ts --live`。不能使用已经过期的历史日期，也不能删掉 formal.claim 来绕过同批启动限制。

运行器核对当前校准、模拟、完整前置与源码一致；核对双方输入与两次基线一致。每次 30 分钟/50 次生成请求；每轮独立验收最多 15 分钟。每对至少预留 130 分钟墙钟窗口。为本机归档保留 4 GiB 空间，低于该值不启动新配对；工作卷仍采用 2 GiB 监测限制。

正式活动期间冻结 src、scripts/eval、evals、tests 及依赖配置。可以记录进展，但不能一边改验收器或题目一边继续计同一批。

### 本次验收器修正后的续跑

原批次在 5 份完整交付后停止，原因是 JUnit 混合结果计数错误。原机判保留，修复后的完整离线复验写入研究目录 offline-v2/。入口为 `bun run scripts/eval/c7/regrade.ts`，不请求模型。

修复版通过重新校准、模拟和完整前置后，设置 `AXI_C7_CONTINUE_FROM` 为原批次目录，保持原 `AXI_C7_DEADLINE=1794441634754` 和镜像，再执行 run.ts --live。程序校验原始交付前缀、输入及限定源码差异，只执行剩余 7 次。使用独立 continuation.claim 与 continuation-batch.json；不得删除原 formal.claim，也不得把原截止改成新的 13 小时。

最终结果同时读取原 formal-batch.json、offline-v2/results.json 和 continuation-batch.json。原错误机判不能作为有效的候选失败；5 份原代码与新批产物使用同一修复版验收，原始文件不覆盖。

## 查看结果

研究目录的 formal-batch.json 指向正式批次。批次内包含：

| 文件 | 用途 |
|---|---|
| manifest.json、source-snapshot/ | 冻结代码、模型、镜像、顺序、前置和截止时间 |
| results.json | 所有实际运行，包含失败及原始配对 |
| selection.json | 正式采用的完整配对；环境补跑不会混拼旧对方 |
| completion.json | 完成范围、启动次数、补跑和停止原因 |
| 任务目录中的 input.json、initial-files.json、initial-git.json | 本次真实输入及 Git 初态 |
| delivery-files.json、final-files.json、final-git.json | 交付现场与最终产物 |
| verification/grade.json | 行为、旧回归、保护及新增测试回放结果 |
| execution.json、io.jsonl、native/、relay/、TRACE.md | 实际工具、模型、终端、允许响应头及原生日志 |

codePassed 与 regressionPassed 是自动判定。fullDeliveryPassed 初始为 null：最后还要对照 Trace 核对交付报告，并查看新增测试断言是否确实针对缺陷。自动回放通过不能代替这个语义检查。审查记录另存，原始评分与日志不覆盖。

环境事件依据最后一次生成请求分类，之前曾遇到 429 不足以解释后续失败。未分类异常会停止新增运行。任何补跑、校准修正或事后新增检查均保留来源和版本。

最终报告只公开脱敏摘要；原始 Trace、故障现场、私有状态和镜像保留在本机。日志缺失或超限必须显式标记，不能称为完整可观察记录。
