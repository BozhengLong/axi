# C6/R3：输出过滤与用户策略接入

> 控制器侧设计稿。只在 R2 结束、稳定快照保存且冻结用户补丁成功应用后投递。本轮开始才公布以下新要求。

## 投递文本与新契约

用户更新了 `examples/c6-consumer/policy.ts`，新增的变更清单和保护哈希随本轮材料提供。`notes.md` 仍保持原样。请保留这些文件的当前内容，并在原实现上完成以下扩展。

1. 新增 renderer 选项 `includeOutput?: boolean`，默认为 true。false 时不输出 output 记录，但仍输出 state 和 run_end；seq 按实际写出的记录连续，不能为被过滤记录留空号。旧调用者不配置时行为不变。
2. 新增 `transformText?: (text: string) => string`，默认原样返回。对每条即将输出记录的 title 和 output 字段调用它，保存返回值。ID、state、type、runId 等结构字段不经过转换。被 includeOutput 过滤的记录不触发转换。不会改写 Task 原始对象。
3. 转换函数同步抛出任意值时，按原 writer 失败规则报告原值一次并停止所有后续输出，不改变业务结果。若运行时返回非字符串，产生 TypeError，交给 onError 一次并停止输出。onError 自身失败仍被隔离。异步转换不在接口范围。
4. 修改可写的 `examples/c6-consumer/run.ts`，从用户 policy 导入 `formatText`，作为 transformText 接入公开 renderer。不要复制、硬编码或覆盖用户规则。示例用合成的 `token=demo-secret` 和普通文本展示策略结果；stdout 仍只有 JSONL。

上轮公开契约、原测试、类型与受保护文件要求全部继续成立。请补充类型、文档和自己的测试，实际运行环境说明中的相关命令，验证旧默认值、新选项组合、异常隔离和用户策略接入。

最后报告实现、实际检查、是否保留用户文件，以及仍存在的问题。交付后由控制器结束会话。

## 控制器执行约束

用户补丁前置哈希不符时，不应用补丁，不把 agent 破坏的文件覆盖成“已恢复”。该轨迹按保护失败结束并保留现场。补丁只能修改冻结清单中的 policy 文件；R1/R2 的候选代码保持不变。向双方提供相同版本的补丁说明和保护规则。
