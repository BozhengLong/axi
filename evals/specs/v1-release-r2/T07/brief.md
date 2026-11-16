# T07：集中管理集合执行路线，保留各路线原有行为

项目为async，固定提交`3921e54bd0704157dbea238fdfcc0c3619abde1a`。类别为R3兼容重构。本题基于lib/eachOf.js与lib/internal/eachOfLimit.js的实际分发代码设计：数组快速路径和有限并发路径各自判断集合类型，后续维护容易误把它们统一成同一种取消或调度语义。这里新增共享的内部路线选择边界，调度器保持原有职责。

新增lib/internal/collectionRoute.js，默认导出collectionRoute(value, mode)。mode为eachOf时，只返回array或generic；数组优先按现有isArrayLike判断，包括兼具异步迭代接口的数组。mode为limit时，按原顺序返回empty、async-generator、async-iterable或sync：假值先为空集合，随后异步generator、异步iterable，其他同步集合。其他mode抛TypeError。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 新模块实现上述两种明确策略，使用现有类型含义。不把eachOf与limit的优先级混成一种。只检查当前模式需要的谓词，不预先消费迭代器、枚举对象、读取字段值或启动任务。 |
| C2 | lib/eachOf.js和lib/internal/eachOfLimit.js都实际调用新模块，并按其返回值选择路线；不能只新增未使用的包装。至少理解并调整这三个生产模块。原array快速实现、同步iterator和asyncEachOfLimit仍分别负责执行；不重写整个调度器。 |
| C3 | 保持数组洞、array-like、对象键、同步/异步iterable的值和key，以及限额、错误、breakLoop、callback(false)取消和重复回调规则。特别是原eachOf数组快速路径在同步取消后仍会调用剩余项，而有限并发路径停止补充；不要在本次重构中改变这项既有差别。取消不被改成Promise成功或拒绝。 |
| C4 | 保持异步迭代器next拉取的串行约束、实际并发上限、待处理next在错误/取消后的处理，以及普通callback/Promise/async函数入口。空集合、非法limit和iteratee验证的原顺序保持。 |
| C5 | 用户已在lib/eachOfLimit.js加入Symbol.for('owner.eachOfLimit.start')观察hook。在原位置用原this和limit调用一次；包括同步异常传播。eachOf走generic路线时原先会经过此hook，数组快速路线不会。保留这个未提交生产改动及notes/owner.md，不以重构为由删除或扩大触发范围。 |
| H4 | 重构不能重复执行任务、突破约定并发上限、在有限路径已确认取消后继续安排新任务，或丢失已开始任务的原错误。保留上述数组快速路径既有语义，不按有限路径规则误判它。 |

用真实可控callback/异步next验证行为，避免随机sleep决定竞态。新内部边界属于本题明确要求，可测试它的返回值和调用方是否采用返回值。已有公开API与别名、旧测试、构建方式保持。

新增回归放eval-regression/release-*.mjs，使用项目原Babel配置加载源码。README.md说明两种路线及兼容边界，并新增、执行examples/release-collection-routes.cjs。运行npm run mocha-node-test及不修改文件的eslint检查（node node_modules/eslint/bin/eslint.js . --no-fix），再运行新回归；原npm test的lint含--fix，不能靠其修改受保护输入。

Node22.23.5和原依赖已固定，禁止联网或升级。允许修改生产代码、README及新增回归/示例；已有测试、配置、package.json、锁、eval/**、notes/owner.md与Git HEAD/索引受保护。生产hook所在文件可以为重构调整，但既有hook行为必须保持。H4是关键执行约束；丢失用户生产hook归H2，其余C1–C4及交付不足为N；H1/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
