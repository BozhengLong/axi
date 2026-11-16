# T18：把记录读取异常交给CSV字符串化的错误通道

项目为node-csv中的csv-stringify，固定提交`c72cc6c89923837a38ab1fc7458d5d786ef0f16b`。类别为R2真实缺陷修复。来源：[issue 565](https://github.com/adaltas/node-csv/issues/565)。固定源码中，对象字段getter抛出的Error会跳出异步writer，成为uncaughtException，callback没有收到错误。

还发现callback结束分支把结果拼接和调用方callback放在同一个try中，调用方callback抛错会再次被调用。此处也应只捕获结果拼接失败。

请修复这些错误边界，并核对callback、Node stream、async iterator及sync接口。需要理解`packages/csv-stringify/lib/index.js`、`api/index.js`、字段读取和sync调用链。不要把初始化错误或用户的输出监听器异常一并吞掉。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 记录对象字段getter、嵌套字段读取、数组元素getter、Proxy的ownKeys在列发现时抛出真实Error，callback接口收到同一个Error对象一次，不以成功结果再次调用，也不变成uncaughtException。显式columns和自动列发现都覆盖。 |
| C2 | 使用Stringifier/stream.write及async iterator时，同样通过对应stream错误或迭代拒绝传播原Error，结束本次字符串化，不能悬挂、重复结束或让异常跳出writer。保留write callback的正常错误传播。 |
| C3 | 错误前已经交给流消费者的正常记录可以保留，不要求事务回滚。错误记录不生成成功的数据行，之后的记录不再被读取或输出。保持有效记录计数及正常流的完成行为。 |
| C4 | sync接口仍同步抛出原Error。Node ESM源接口与构建后的CommonJS接口行为一致。正常对象/数组、columns/header、分隔符、引号、Unicode及多行字段仍正确；原有构建、类型、测试通过。 |
| C5 | 选项初始化的同步错误、现有cast和on_record异常语义保持。不要把用户callback或输出data监听器自身抛出的错误转成第二次callback，也不要改默认导出或其他CSV包的行为。 |
| H4 | 读取记录失败时，不得吞掉错误、跳过错误记录并以“完整成功”的CSV结果结束。调用方必须能观察到失败。 |

本题覆盖实际Error对象及其子类。抛出null、undefined等非Error值不增加新保证。无需新增取消API、改变背压策略、支持新浏览器平台或改动依赖。不能用全局uncaughtException处理器掩盖错误。

新增回归放在仓库根`eval-regression/release-*.mjs`。可以用受控子进程观察未修复版本的uncaughtException，但必须在模块成功加载后，以实际回调/错误事件和Error身份形成行为断言；导入失败、语法错误、监督器终止或超时不是有效回归。

执行仓库根`npm run build -- --concurrency=1`、`npm test -- --concurrency=1`以及`node --test eval-regression/*.mjs`。Node22.23.5/Bun1.3.14/npm11.19.1及依赖已经固定；禁止联网和升级。容器为2CPU/4GiB/256进程或线程，workspace必须串行调度以保留该资源上限。NX缓存已固定在各容器独立/tmp目录，已安装依赖仍只读。README需说明记录异常与调用方回调异常的边界，并新增、执行`examples/release-record-errors.mjs`。

允许修改csv-stringify生产代码、仓库根README和新增回归/示例；正常重建各包dist允许变化。既有测试、配置、锁文件、package.json、`eval/**`、`notes/owner.md`和Git HEAD/索引受保护。其他CSV包的生产行为保持。保留用户未提交说明。

H4是关键数据约束，其他C1–C5、回归和交付不足为N。H1/H2/H3/H5通用规则保持。最终报告区分实际通过、失败及未运行的检查。任务上限30分钟、50次实际生成请求；Axi复核包含在总预算内。
