# C6 运行与复验指南

> 本次研究已完成。设计见 [C6 设计](../05-c6-continuous-evaluation-design.md)，结果见[对照报告](../verification/2026-11-11-c6-comparison.md)。本指南供维护评测设施和复查证据使用。手动体验 Axi 见[首次试用指南](v0-first-use.md)。

## 1. 先区分三种记录

| 记录 | 使用范围 |
|---|---|
| C6 revision 2 | 本次正式模型运行的冻结验收，双方各 3/3 |
| C6 revision 3 | 评测后补入事件分发中的结束清理检查，保存产物完整离线复验后双方各 2/3 |
| 响应头修复后的镜像 | 保留 Retry-After 等响应元数据，用于后续研究；未用于本次 C6 原始运行 |

每条轨迹包含三轮。重新验收保存代码，不等于重新让模型生成代码。复现冻结成绩时使用批次的 `source-snapshot` 与正式镜像，不能用当前扩展验收器覆盖原结果。

## 2. 本机证据入口

- [全部 C6 真实轨迹索引](/Users/spidey0o0zheng/.local/share/axi-evals/c6-20261111/TRACE-INDEX.md)。
- [逐轮完整离线复验](/Users/spidey0o0zheng/.local/share/axi-evals/c6-20261111/offline-v3/results.json)。
- [补充边界和对照条件](/Users/spidey0o0zheng/.local/share/axi-evals/c6-20261111/supplemental-end-during-subtask-v2/results.json)。
- [真实本地 HTTP 转发回归](/Users/spidey0o0zheng/.local/share/axi-evals/c6-20261111/response-headers-preflight.json)。
- [正式镜像归档哈希](/Users/spidey0o0zheng/.local/share/axi-evals/c6-20261111/formal-revision2-image.tar.json)。

各任务目录中，先读 `result.json` 和 `round-results.json`，再按需要查看 `round-N/grade.json`、`round-N/files.json`、`round-N/git.json`、反馈和原生会话记录。每个 `TRACE.md` 都链接该轨迹的文件清单与 SHA-256。

试跑为 `b20261111043124`。原正式为 `b20261111050133`。完整配对补跑为 `b20261111055531`。正式采用补跑首对与原第二、三对；原始首对两条仍保留。

## 3. 当前实现入口

- [任务与参考产物](../../scripts/eval/c6/task.ts)、[工作目录及上游 Git 起点](../../scripts/eval/c6/workspace.ts)。
- [独立验收](../../scripts/eval/c6/grade.ts)、[校准](../../scripts/eval/c6/calibrate.ts)。
- [连续会话前置](../../scripts/eval/c6/check-continuity.ts)、[运行调度](../../scripts/eval/c6/run.ts)。
- [保存产物复验](../../scripts/eval/c6/regrade.ts)。
- [响应头本地 HTTP 回归](../../scripts/eval/c6/check-response-headers.ts)、[原生日志容量回归](../../scripts/eval/c6/check-native-limit.ts)。

控制器使用 Bun；被测 Listr2 使用 Node/pnpm/Jest。依赖卷为 `axi-c6-dependencies-20261111`，只读挂载。正式旧镜像为 `axi-eval-c6:formal-revision2`，新响应头镜像为 `axi-eval-c6:headers-revision3`。正式镜像已单独导出，本次保留两种镜像。

## 4. 离线复验

以下命令读取本机已有的原始产物。不会调用模型。

```sh
cd /Users/spidey0o0zheng/workspace/axi
bun run scripts/eval/c6/regrade.ts
```

该入口校验原始产物哈希，从冻结的控制器反馈重建保护基线，再用当前 revision 3 验收六条正式采用轨迹的 18 份快照。结果写入研究目录 `offline-v3/`。

本次还准备了一个旧版复现入口。它从原批次 `source-snapshot` 加载 revision 2 验收器，检查 Axi 第 2 次的 R3 产物：

```sh
bun /Users/spidey0o0zheng/.local/share/axi-evals/c6-20261111/reproduce-frozen.ts
```

已验证：这个产物在旧版的 25 组检查通过，在新版仅失败 H-END-DURING-SUBTASK。旧版复现结果另存为 `frozen-reproduction/`，不覆盖任何原文件。评测后的 revision 3 与响应头修复源码另存为 `post-run/revision3-final/`；三个原始批次源码快照已逐文件核对。

## 5. 再次执行真实评测

新的研究先分配新目录和批次标识，保留本次证据。当前 `settings.ts` 和私有索引指向本次固定研究，不是通用定时任务配置。

按以下顺序准备：固定目标提交和镜像 → 原项目基线 → 参考与错误变体校准 → 同会话三轮模拟 → 全流程模拟 → 真实连通性 → 试跑 → 冻结正式版 → 配对运行与复查。

初始化和显式真实前置的入口为：

```sh
AXI_EVAL_IMAGE=axi-eval-c6:headers-revision3 bun -e 'import { initialize } from "./scripts/eval/core.ts"; const batch = await initialize(); console.log(batch.id);'
bun run scripts/eval/preflight.ts --complex --live
```

运行器要求 `AXI_EVAL_IMAGE` 和明确的 `AXI_C6_DEADLINE`（epoch 毫秒），并检查已批准的前置结果和校准结果。每轮 30 分钟/50 次生成请求，三轮总计 90 分钟/150 次。验收暂停不计入 agent 活动时间。剩余时间不足容纳完整配对及报告时不启动新配对。

环境补跑通过独立事故文件与一次性 claim 控制，整对从新初态运行。普通代码失败不触发补跑。任务结束清理容器、专用网络和临时工作卷，保留私有证据、依赖卷与镜像。

## 6. Trace 的范围

本次历史轨迹已保存 API 正文/SSE、工具、终端、原生会话和逐轮文件。旧转发器没有保留上游响应头，这个缺口无法事后补回。新实现记录并透传重试、限流和请求 ID 等允许字段；不包含认证头，也不承诺服务端未返回的内部思考。

原生日志导出上限为 128 MiB；若收取超限，清单必须明确标记缺口，不能称为完整。该上限已用约 40 MiB 的合成文件跨旧上限校验。
