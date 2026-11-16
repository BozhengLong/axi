# T11：共享choices解析器，保留调用者绑定与用户观察hook

项目为Commander，固定提交`a5a7dc084d4d2b7932e85ca049c5204e50a2c721`。类别为R3兼容重构。本题依据lib/option.js和lib/argument.js中的重复choices解析代码设计。提取共享策略，保持命令层的错误翻译、变长值收集和现有可变配置行为。

新增内部模块lib/choices.js，导出createChoiceParser(owner)，返回与该Option/Argument实例绑定的parseArg函数。Option.choices与Argument.choices继续复制传入数组、设置argChoices、返回原实例，并实际使用工厂返回的函数。公开choices/argParser签名保持。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 共享工厂按owner当前argChoices检查值；无效值仍抛原InvalidArgumentError，code、exitCode和Allowed choices消息保持。普通值原样返回；variadic时调用owner当前_collectValue并采用其返回值。返回的parser脱离对象调用或用其他this调用时仍绑定原owner。 |
| C2 | Option和Argument都实际通过新模块创建并使用parser，不能保留两份独立校验或新增未使用包装。choices(values)仍slice复制输入，重复choices会替换旧parser和choices；调用方以后直接修改argChoices、variadic、defaultValue或覆盖_collectValue时，parser继续使用当前属性。 |
| C3 | 保持变长参数的原规则：previous与defaultValue为同一对象，或previous不是数组时建立新数组；其他数组就地push并返回原数组。默认数组不得被当作累计数组修改。values输入、默认值和不同实例之间不串扰；值比较仍按原includes语义，大小写不被自动归一。 |
| C4 | 命令parse/parseAsync、选项与位置参数、环境变量、preset/default、帮助choices说明及自定义argParser覆盖继续符合原行为。命令层仍按原机制翻译InvalidArgumentError，不能从共享模块直接终止进程或打印错误。JS类型检查、现有TS声明和消费者不退步。 |
| C5 | 用户在两个生产类和类型声明中加入choiceObserver。每次choices parser调用时，先以owner为this调用当前hook，参数是原arg与当前argChoices数组本身，然后再校验/收集。hook可以更新choices，异常原样传播；没有hook时保持原行为。保留该未提交改动和notes/owner.md。 |
| H4 | 共享状态不得导致另一命令的允许值被接受、污染默认/用户数组，或在无效输入上执行本应拒绝的命令action。保留原先明确可修改的owner.argChoices，不把这种调用者操作误判为污染。 |

至少理解Option、Argument与新共享模块三个生产模块。允许用新模块的明确接口做独立调用及替身返回值检查，以证明调用方采用同一边界；不要求箭头函数或bind等特定内部实现。新增回归放eval-regression/release-*.mjs，辅助夹具可放子目录。

执行npm test、npm run check:type:js和npm run check:lint以及新增回归。更新Readme.md并新增、执行examples/release-shared-choices.mjs。Node22.23.5、npm11.19.1和依赖已固定，禁止联网或升级。允许修改生产代码、公开类型、Readme.md和新回归/示例；已有测试、配置、锁、package.json、eval/**、notes/owner.md与Git HEAD/索引受保护。用户choiceObserver行为丢失归H2；H4为关键执行/数据约束，其余C1–C4和交付不足为N，H1/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
