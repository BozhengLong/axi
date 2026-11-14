# V1-D：p-retry单次尝试超时与取消上下文

你接手p-retry 9.0.0，上游提交`ac3c4cdb7f015e1f71825e4274e2323a49b615eb`。现有maxRetryTime在失败后决定是否继续，不能结束一个永不settle的input。调用方需要显式启用每次尝试的超时，并把该次取消信号交给实际操作。请扩展现有重试循环，保留已有策略和接口。

## 选项与调用方式

- 新增`attemptTimeout?: number`。省略、undefined或null沿用全部旧行为，包括input只收到attemptNumber、没有新增尝试计时器、外部取消不抢先结束一个仍运行的input。
- 提供正整数1至2147483647，或Infinity时启用新尝试模式。有限值是每次input的毫秒时限；Infinity只关闭尝试计时器，仍启用下述上下文和即时外部取消。其他值在调用input前拒绝为TypeError。
- 新模式调用`input(attemptNumber, context)`。context含只读`signal: AbortSignal`，每次尝试使用独立信号。外部signal预先取消时不得调用input；同步或异步input均支持。
- 导出`AttemptContext`类型、`AttemptTimeoutError`类。超时错误继承Error，name为`'AttemptTimeoutError'`，提供只读attemptNumber和timeout，分别为当前尝试号和配置毫秒数。构造签名为`new AttemptTimeoutError(attemptNumber, timeout)`。类型声明须保留旧单参数函数的推导；明确提供数值attemptTimeout时，第二参数可直接推导为AttemptContext而非undefined。

## 状态和错误

- input成功或失败后，取消本次计时器并移除库安装的外部abort监听。正常成功/失败不会主动abort该次context.signal。进入失败回调或等待退避时，尝试计时器已停止。
- 有限时限到达且input仍未完成时，该次尝试以一个AttemptTimeoutError失败，同时用同一个错误对象abort该次context.signal。input响应abort而reject的另一操作错误或稍后settle，都不能替换这次超时结果。
- 超时作为普通可重试失败，继续经过现有shouldConsumeRetry、onFailedAttempt、shouldRetry、retries、maxRetryTime和退避规则。回调拿到的error就是该次超时对象。不得绕过用户的重试决策，也不得超时一次就重置预算。
- 新模式在input运行期间收到外部取消时，立即以外部signal.reason原值结束，包括falsy值和AbortError对象；同一原值转发给context.signal。取消不调用失败回调、不再开始下一次尝试。外部取消与超时竞争时，以首先处理的终止事件为准；沿用原循环在失败回调阶段对已取消signal的最终判定。
- 迟到的input成功、失败或thenable结果不能改变已经确定的结果、重复调用回调或产生库新增的未处理拒绝。不能安装全局异常兜底来通过测试。
- 超时只停止等待并发出合作取消，不强制终止用户代码。input若忽略signal，可能与后续重试重叠；文档必须说明。同步阻塞不能被JS计时器抢占，不要求硬实时保证。用户abort事件处理器直接向进程抛出的异常不是input的Promise拒绝，不要求库拦截该类用户代码异常。
- `unref:true`同样应用于新增尝试计时器。成功、失败、超时、外部取消后不遗留计时器或库的abort监听；无unref平台仍可用。不同pRetry调用、不同尝试之间不能共享可变取消状态。
- 现有maxRetryTime仍按原规则计量，不改为整个调用的强制总超时。失败策略回调和退避不计入单次input时限。新模式以外的AbortError解包、网络TypeError、非Error规范化及原回调顺序保持。
- makeRetriable支持该选项，但不得给被包装函数注入额外参数或改变this/原参数/返回类型；它不能自动把context.signal交给任意业务函数，这一限制须说明。

## 交付

更新index.js、index.d.ts和readme.md，不新增生产模块，现有包发布清单保持。新增测试及其辅助文件放在eval-tests。原测试/原类型测试、配置、依赖锁及用户文件不可改。不要提交、暂存、stash或重置。基线复验使用隔离副本，不覆盖当前或用户文件。

新增回归放在eval-tests/*.test.mjs，使用node:test和node:assert/strict，不引入依赖。相同最终测试在原实现上至少因目标行为断言失败，在新实现上通过。不要只检查API存在；需要真实的超时、重试、取消、迟到拒绝和清理断言。基线缺少新导出时用断言说明，不能仅因导入失败或进程超时判为有效回归。

先读eval/environment.md和保护清单，实际运行原运行测试、原类型测试、新回归及相关示例。最后用中文准确报告修改、命令及真实退出码、未完成项和未验证风险。旧行为或无影响的风险判断须有适用证据或明确标为未验证。
