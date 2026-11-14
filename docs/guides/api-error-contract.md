# 流式API错误记录契约

2026-11-14，依据[发布候选D1](../10-v1-release-candidate-plan.md)。只在JSON对象的`type`为`error`时解析`error`字段。正文、工具参数和用户内容不作为错误事件。

产品与评测观察器分别实现解析，字段一致：

| 字段 | 含义 |
|---|---|
| `errorType` | 结构化的字符串类型；已知字符串映射为`rate_limit_error`；缺少类型时为`unknown_error` |
| `message` | 原字符串或结构化message；畸形结构以JSON说明 |
| `format` | `structured`、`string`或`malformed` |
| `rule` | `structured-type`、`gateway-rate-limit-v1`或`unrecognized` |
| `retryable` | 仅`overloaded_error`、`rate_limit_error`、`api_error`、`connection_error`为true |

字符串规则只匹配完整文本：`This request would exceed your account's rate limit. Please try again later.`。不做子串、大小写或空白扩展匹配。鉴权错误不重试；未知类型停止。

原SSE保留在私有Trace。产品`request_error`增加`rawError`、`normalizedError`、`retryable`与`willRetry`；错误详情中的当前key和API完整地址脱敏。`retry_scheduled`记录下一attempt和等待时间；它表示已安排等待，不表示请求已经发出。实际请求以`request`为准。最多三次重试，每次都受实际请求预算和任务截止约束。

转发器只旁路增加`api_error.normalizedError`，不重写SSE字节。评测器独立读取原SSE及HTTP状态，最后一次生成请求的鉴权失败记为`authentication_failure`，未知错误为`unclassified_failure`，明确临时上游错误为`environment_indeterminate`。是否允许补跑仍由所在阶段的授权控制。

测试使用固定输入和独立预期结果；不以产品解析器输出作为评分器的预期值。两者实现相同契约不能代替真实CLI、隔离和原始字节透传验证。
