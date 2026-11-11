# C6/R1：公开 JSONL renderer 契约

> 设计稿。确认并完成准备后，本文件随 R1 投递。不得包含 R3 新要求。

## 接口与旧行为

- 从 `listr2` 包根导出 `JsonlRenderer`，支持 `renderer: 'jsonl'` 及对应泛型选项。生成的声明文件和运行时都可用；消费者不得使用内部源码路径。
- 在普通非 TTY 环境中可以选择 jsonl，不被默认 fallback 换成其他 renderer。现有显式 silent/fallback 条件仍按原项目规则执行。
- 全局选项：`runId?: string`、`writer?: (line: string) => void`、`onError?: (error: unknown) => void`。此阶段不要求每任务专属选项。
- 提供 runId 时使用该值；未提供时，每个实例产生非空且不与其他实例复用的 ID。输入限定为非空字符串，不要求处理错误类型的 runId。
- writer 默认为同步调用 stdout.write。每次传入一条完整 JSON 字符串及一个末尾换行；不添加 ANSI、进度条、说明文字或额外空行。stdout 的背压及异步 writer 不在本题范围。
- 现有 renderer、TestRenderer 的序列化格式、任务返回值、错误、重试、回滚、跳过及中断语义保持兼容。

## 记录结构

每条记录仅有下表规定的字段。键顺序不限；JSON 字符串转义必须正确。

| type | 字段 |
|---|---|
| `state` | `schemaVersion: 1`、`runId: string`、`seq: number`、`type: 'state'`、`taskId: string`、`parentId: string \| null`、`title: string`、`state: string` |
| `output` | `schemaVersion: 1`、`runId: string`、`seq: number`、`type: 'output'`、`taskId: string`、`parentId: string \| null`、`title: string`、`output: string` |
| `run_end` | `schemaVersion: 1`、`runId: string`、`seq: number`、`type: 'run_end'` |

`seq` 从 1 开始，在一个 renderer 实例的实际写出顺序中连续递增。并发任务的相互交错顺序不限，不能根据测试机器的调度顺序要求同一份总序列。`taskId` 使用真实 Task ID，`parentId` 使用直接父任务 ID；根任务为 null。名称相同的任务必须能区分。

`title` 是事件发生时的任务标题，无标题时为空字符串。`state` 为 Task 实际发布的状态值，`output` 为实际输出值；换行和 Unicode 保留内容，不按文本行拆成多条事件。任务对象的标题、输出、状态和 ID 均不能被 renderer 改写。

## 事件与生命周期

- 订阅开始后，每次 STATE 和 OUTPUT 事件各输出一次对应记录。不合成订阅前的初始 WAITING 记录，不因标题变化单独生成新类型。
- 覆盖根任务和运行时创建的多层子任务。每个任务只订阅一次；子任务开始执行前必须已订阅。不漏掉无标题任务。
- 同一实例多次 `render()` 不重复安装订阅。`end()` 最多写一次 run_end，之后不再输出。先 end 再 render 也不能重新开始输出。每次运行使用新实例；不要求已结束实例可重新使用。
- run_end 只表示 renderer 结束，不表示业务成功。任务失败或中断导致正常调用 end 时，也产生一条 run_end；不要求 SIGKILL 等无法执行清理时输出。
- 结束时释放自己安装的监听器，不移除其他订阅者。并列运行及先后运行的实例不共享 seq、runId 或关闭状态。

## 输出失败隔离

writer 可以抛出 Error、Error 子类、含 status 字段的对象或字符串。任意同步异常均按以下规则处理：

1. 标记当前 renderer 的输出通道失败，停止后续所有写出，包括 run_end。
2. 若配置 onError，以原异常值调用一次，保持对象身份。onError 自己抛出时不向外传播，也不递归调用。
3. 不将日志异常变成业务异常，不吞掉或替换业务原错误，不改变成功返回值、业务执行次数、重试或回滚结果。

writer 抛错前可能已经写出部分字节；本契约不要求撤回这些字节。该次失败后的输出不再要求形成完整日志，但必须遵守停止输出和业务隔离规则。

## 交付与验证

完成类型、运行时、文档、自己的回归测试及 `examples/c6-consumer/run.ts` 示例。示例使用真实构建包的公开入口，演示根任务、嵌套任务和包含换行的输出；正常执行只在 stdout 输出 JSONL。

先阅读初态修改和保护清单。不得改写其中的用户文件、原测试/快照、依赖锁文件、构建/测试配置或许可。可以新增测试和文档。预装环境会给出准确的构建、类型检查、原测试、可见验收和示例命令；应实际执行相关检查并如实报告结果。
