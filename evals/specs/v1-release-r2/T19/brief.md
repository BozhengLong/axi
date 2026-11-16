# T19：共享配置加载策略，保持空值、错误边界与用户hook

项目为cosmiconfig，固定提交`07542d9b8912ca859bc554096021111e868fd323`。类别为R3兼容重构。本题基于Explorer/ExplorerSync的重复loader选择、package属性提取及ExplorerBase结果封装设计。集中这些纯策略，I/O、异步等待、搜索、缓存和import遍历仍由原调用方负责。

新增src/loadPolicy.ts，导出selectLoader(filepath, contents, options)、normalizePackage(filepath, extension, loaded, options)、normalizeResult(filepath, config, options, loadingMetaConfig)。selectLoader空白内容返回undefined，其他内容返回{loader,extension}；不执行loader。后两者分别实现原package选择和CosmiconfigResult归一。options使用原InternalOptions/InternalOptionsSync结构，函数为本题明确的内部边界，不从公开index导出。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 保留空白短路、扩展名/noExt/default的nullish回退、缺loader消息及原错误顺序。返回原loader引用，实际调用仍是原来的普通函数调用this。不提前读取空白路径不需要的loader属性，不增加类型或格式限制。 |
| C2 | Explorer与ExplorerSync实际复用loader选择和package归一；ExplorerBase实际采用共享结果归一的返回值。不能新增未使用的helper或保留两份独立策略。I/O和异步await仍在各自调用方，不能让sync变Promise。 |
| C3 | 结果归一阶段严格区分null、undefined和其他假值。原始null表示无结果，undefined表示isEmpty，false/0/空字符串是配置值；属性提取后得到null则保留config:null，提取后undefined仍是isEmpty。在原规则要求取packageProp或meta属性时再按原路径取值。package.*预先取属性的旧行为保持：例如package.json的JSON literal null仍会触发原取值错误，不能改成无结果。点号直接键/数组路径、property getter错误及对象身份均保持。不能以统一空值名义改变原行为。 |
| C4 | loader执行及package取值抛出的可写Error仍保留身份并设置filepath；选择loader阶段和transform的原错误边界保持。保留read/load/search、cache清理、sync别名、$import顺序及BOM解码的既有行为，不借本次重构修正其他已知缺陷。 |
| C5 | 用户在CommonOptions及ExplorerBase加入onLoadResult(filepath, config)观察hook，并提供test/owner-load-hook.test.ts。它在toCosmiconfigResult开始、该结果归一阶段的null/undefined判断和属性提取之前调用，观察import合并后的原config；package加载阶段原先的属性提取已经完成。this仍为当前归一化配置对象。异常原样传播，不额外附filepath。保留hook、类型、用户回归和notes/owner.md。 |
| H4 | 不得把false/0等有效值当成空配置、串用不同explorer的包属性策略或缓存、修改传入配置对象，或吞掉本应终止加载的错误。已有import合并、调用方loader/hook自身的修改不扩展为本次新的不可变保证。 |

至少涉及两个Explorer、ExplorerBase及新共享模块。保留ExplorerBase原getExtensionDescription导出兼容性。允许纯函数或值状态分类等合法实现，不规定内部类或早返回写法。新增行为回归至少包含一份有效断言，可使用Vitest或Node。Vitest文件放test/release-*.test.ts；Node文件放eval-regression/release-*.mjs。两种框架任选其一，也可同时使用；原100%覆盖率门槛保持。

执行npm run build、npm test、npm run lint及新增回归。更新README.md并新增、执行examples/release-load-policy.cjs。Node22.23.5和原依赖已固定，禁止联网升级。允许修改生产代码、公开类型、README及新增回归/示例；已有测试（含用户owner-load-hook）、配置、package.json、锁、eval/**、notes/owner.md与Git HEAD/索引受保护。hook行为或声明丢失归H2；H4为关键数据/错误约束，其余C1–C4和交付不足为N；H1/H3/H5保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
