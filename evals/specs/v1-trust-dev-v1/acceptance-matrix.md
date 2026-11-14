# 可信评测开发题契约映射

版本：trust-development-v1。E/D为已暴露开发题，不计新题迁移。每个运行组由独立子进程执行。两套有效实现均须通过全部原测试、类型和下列契约；参考回归在原库上须由行为断言失败。

| 题 | 断言组 | 公开条款 | 已声明负例 |
|---|---|---|---|
| E | E01–E03、E21 | 参数、键身份、回调接收者和后端接收者 | key-receiver / baseline |
| E | E04–E07 | 逐键失效、旧计算写入权限和读竞态 | missing-invalidation / keep-old-flight |
| E | E08–E10、E16、E19 | 删除屏障、串行、失败释放和重入 | baseline / skip-writes |
| E | E11–E15 | 跨键隔离、共享缓存和已开始写入责任 | skip-writes |
| E | E17–E18 | 原值错误、能力校验和clear兼容 | baseline |
| E | E20、E22 | 默认Node拒绝观察和原生Promise语义 | extra-assimilation |
| D | D01–D02、D21 | 启用/关闭语义、验证、上下文和只读元数据 | baseline |
| D | D03–D06、D10–D12 | 超时身份、预算、重试回调和时间范围 | baseline |
| D | D07–D09、D22 | 原值取消和迟到拒绝观察 | inspect-cancel-reason |
| D | D13、D18–D19 | 资源清理、unref和不可变选项 | listener-leak / timer-leak |
| D | D14、D17、D20 | 默认Node迟到失败、原错误和Promise观察 | extra-assimilation / late-rejection-escapes |
| D | D15–D16 | 并发隔离和makeRetriable参数接收者 | wrapper-injects-context |

| 资格材料 | 检查 |
|---|---|
| 两套正例/题 | primary为独立状态管理参考；alternative为修复后的历史产物。均为人工材料，不计模型成功。 |
| 类型断言 | E参数元组、返回值与导出；D null/undefined关闭、literal name、readonly元数据、上下文推导和包装参数。 |
| 恒真回归/题 | 参考生产代码仍通过，但相同新增测试在原库也通过，必须判回归无效。 |
| 重复资格 | baseline、primary、alternative每题各预先声明5次；失败全保留，不挑最好一次。 |
| 故障设施 | 时限、信号、取消、空/不一致报告归不可判定；语法错误不得充当行为断言失败。 |

各组的具体断言见[完整E oracle](../../v1-trust-dev-v1/oracle/E-test.mjs.fixture)和[完整D oracle](../../v1-trust-dev-v1/oracle/D-test.mjs.fixture)。

## 断言名称索引

### E

- `E01 validation always returns a promise`
- `E02 original key function copied arguments backend this and return`
- `E03 identity keys remain distinct and delete never clears`
- `E04 old computation loses write permission and new calls deduplicate`
- `E05 old cleanup cannot remove newer in flight registration`
- `E06 invalidation during shouldCache prevents stale write`
- `E07 asynchronous cache reads cannot return invalidated hit`
- `E08 pending deletion blocks new reads computation and writes`
- `E09 same key deletes serialize and later delete survives failure`
- `E10 a waiter cannot cross a later pending deletion`
- `E11 other keys and cache objects stay independent`
- `E12 shared cache invalidates old writes but only target deduplication`
- `E13 delete waits for already started async shared cache set`
- `E14 a failed old write does not cancel backend deletion`
- `E15 set reentry is registered before invoking user cache`
- `E16 failed deletion releases waiting calls and permits retry`
- `E17 raw callback errors and invalid capability preserve existing work`
- `E18 clear keeps synchronous semantics and started set caveat`
- `E19 delete hook reentry waits without starting duplicate work`
- `E20 default node has no orphan internal rejection`
- `E22 native promise observation preserves the original rejection`
- `E21 key callback keeps the original unbound receiver`

### D

- `D01 validation and explicit versus legacy input arguments`
- `D02 timeout class metadata and successful context`
- `D03 timeout is retried and its signal reason is the callback error`
- `D04 failure callback order and shouldRetry decision are honored`
- `D05 nonconsuming timeout does not reset or consume the retry budget`
- `D06 repeated timeouts exhaust the existing budget`
- `D07 pre-aborted reasons are final and preserve identity`
- `D08 external abort ends an infinite attempt immediately and forwards raw reasons`
- `D09 synchronous external cancellation still observes a returned rejection`
- `D10 abort reaction cannot replace the timeout error`
- `D11 attempt timers stop before callbacks and backoff`
- `D12 maxRetryTime still controls continuation without becoming a hard deadline`
- `D13 timers and external listeners are released on every terminal path; unref is used`
- `D14 late promise and thenable rejection do not escape a default Node process`
- `D15 concurrent calls have independent cancellation state`
- `D16 makeRetriable preserves this and parameters under timeout mode`
- `D17 synchronous throw and throwing then getter preserve the original error`
- `D18 options remain untouched and a timer without unref works`
- `D19 unref attempt timer does not keep an otherwise idle process alive`
- `D20 native promise observation preserves the original rejection`
- `D21 error metadata and attempt context are readonly at runtime`
- `D22 pre-aborted opaque reason is not inspected or normalized`

