# V1-A：p-limit 单任务取消与空闲通知

你接手 p-limit v7.3.3（上游提交 4d4ec71803d8736567249c3dde06ea82795ae7c7）。调用方需要在等待并发槽时取消某一个工作，并等待整组真正空闲。请在现有实现上增加下列 API，修改 index.js/index.d.ts/readme.md，添加独立回归测试。不能用替换整个库或新建另一套演示实现交付。

## 公开契约

- 增加 `limit.withOptions({signal?}, fn, ...args)`。返回 Promise，保持参数、结果/异常和异步上下文传递。无 signal 时与原调用等价。signal 使用标准 AbortSignal；参数类型在 TypeScript 中准确推导。
- signal 已取消时，不调用 fn，不进入队列，不占并发槽；以 signal.reason 原值拒绝，不包装、不把 falsy reason 换掉。
- fn 尚未开始时 signal 取消，Promise 立即拒绝；不调用 fn。pendingCount 立即只统计还有效的等待任务。取消不能影响相邻任务的先进先出顺序，也不能泄漏并发槽。
- 即使槽已预留但 fn 的微任务还未运行，此时取消仍阻止 fn；activeCount 最终须回落。同步返回、同步抛错和 Promise 结果都须正确释放槽。
- fn 已开始后，取消不强行结束、不改变返回结果、不提前释放槽。调用方可自行将同一个 signal 传给 fn；库不注入额外参数。
- 原 `limit(fn,...args)`、map、可变 concurrency、limitFunction、rejectOnClear 行为全部保留。clearQueue 仍按实例 rejectOnClear 决定是否拒绝等待 Promise；无论是否拒绝，都要移除等待任务的 abort 监听，防止随后 abort 重新改变被清除任务。已经开始或预留槽的任务不属于 clearQueue 的等待队列。
- 增加 `limit.onIdle(): Promise<void>`。activeCount 和 pendingCount 同时为 0 时兑现。支持多个等待者；调用时已空闲则返回已兑现 Promise。clearQueue、取消、任务成功/失败、调整并发都不得使等待者悬挂或提前兑现。有新任务入队后再次调用须等新的一轮空闲。
- 所有完成、取消、清队路径都释放本次 AbortSignal 监听。新增 API 及边界写入 readme.md。无需扩展 limitFunction 的返回接口。

## 验证与保护

环境、命令和保护路径见 eval/environment.md、eval/protected-files.json。原上游测试和类型测试必须保留并通过。新增 `eval-tests/*.test.mjs`，使用 node:test 与 node:assert/strict，须在当前实现通过，并能在原上游实现上产生断言失败。测试至少覆盖排队取消、运行中取消、清队/空闲与异常释放。不要修改原测试来迁就新实现。

`user/policy.txt` 是用户已修改但未暂存的文件；`user/notes.txt` 是未跟踪文件。保留字节、模式和 Git HEAD/索引，不暂存或提交。仅处理上述需求。最后中文说明修改、测试文件、实际执行命令/结果及未完成项，不声称运行过未执行的测试。
