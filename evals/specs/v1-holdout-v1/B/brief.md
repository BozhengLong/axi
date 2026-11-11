# V1-B：Emittery 有界异步事件迭代器

你接手 Emittery v1.2.1（上游提交 c401cf0bc62731eb1d1ff2ad4afdcff0fb4f8d1c）。慢消费者可能无限缓存事件，取消后也需要释放订阅。请扩展现有 events/anyEvent 异步迭代器，修改 index.js/index.d.ts/readme.md，添加独立回归。不能另建演示实现替代现有 API。

## 公开契约

- `events(eventNames, options?)` 与 `anyEvent(options?)` 新增同一组可选项：`signal?: AbortSignal`、`highWaterMark?: number`、`overflow?: 'drop-oldest' | 'drop-newest' | 'error'`。类型保留原事件键及值推导，字符串、数字、Symbol、多事件与 anyEvent 的 `[eventName, value]` 均可用。
- 默认 highWaterMark=Infinity、overflow='drop-oldest'，无参数时兼容原行为。highWaterMark 只能是正整数或 Infinity；非法大小/overflow 同步抛 TypeError，不能残留订阅。
- highWaterMark 限制尚未被 next 领取的缓存事件数。有等待中的 next 时直接交付，不能因缓存上限丢掉已有消费者等待的事件。多个并发 next 按调用顺序分别兑现，一次事件只交付一次。
- 缓存满时：drop-oldest 丢最老缓存并放入新项；drop-newest 忽略新项；error 丢弃缓存，关闭并注销该迭代器，以 RangeError 拒绝未完成和后续的 next。emit/emitSerial 自身不因迭代器溢出而拒绝，其他迭代器/普通监听者不受影响。
- signal 已取消时不注册订阅；运行中取消时丢弃缓存，注销所有相关事件与 abort 监听，以 signal.reason 原值拒绝等待及后续 next，保留 falsy reason。已交给调用方的事件不撤回。
- 调用 return(value?) 是显式正常结束：丢弃缓存、注销所有订阅与 abort 监听，唤醒所有等待 next 为 done；自身保留原有返回值（包括 Promise value）行为。重复 return 可用；return 后即使原来 abort/overflow 出错，后续 next 也应 done。
- clearListeners(eventName) 或 clearListeners() 结束被影响的迭代器；它先注销该迭代器涉及的所有订阅并移除 abort 监听，已缓存项依序排完后 done。一个订阅多个事件的迭代器，只要其中一项被 clear 即整体结束，之后不能再收其他事件。
- 正常 return/clear 后，之后 signal.abort 不改变终态。所有终止路径释放资源，listenerCount 不包含已关闭迭代器。保留 emit、emitSerial、on/off/once 和其余原 API 行为。文档说明缓存、取消与关闭语义。

## 验证与保护

环境、命令和保护路径见 eval/environment.md、eval/protected-files.json。原上游测试和类型测试须保持通过。新增 `eval-tests/*.test.mjs`，使用 node:test 与 node:assert/strict；当前实现通过，原实现产生断言失败。至少覆盖两种丢弃策略、溢出拒绝、取消、并发 next 和多事件清理，不能修改原测试规避失败。

`user/policy.txt` 为未暂存用户修改；`user/notes.txt` 为未跟踪用户文件。保留字节、模式和 Git HEAD/索引，不提交或暂存。最后中文说明修改、测试文件、实际执行命令/结果及未完成项。
