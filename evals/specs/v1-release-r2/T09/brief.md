# T09：按输入顺序汇总多个配置文件的加载结果

项目为cosmiconfig，固定提交`07542d9b8912ca859bc554096021111e868fd323`。类别为R1多模块功能。本题基于README现有load、transform、cache API提出批量消费者需求：检查一组项目配置，保留每个输入的成功或失败，限制同时进行的文件加载。新API由本题定义，不声称已有issue规定了这些名称或细节。

增加异步explorer.loadAll(filepaths, options?)和同步explorerSync.loadAll(filepaths)。公开导出LoadAllOptions（concurrency?: number）与LoadAllResult判别联合。每项为{filepath: string, status:'fulfilled', result:CosmiconfigResult}或{filepath:string,status:'rejected',reason:unknown}。filepath保留对应输入的字面值；result.filepath继续按原load语义处理。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 工厂返回的新方法无需绑定this即可单独使用，公开TypeScript声明正确。filepaths只接受数组，每项为非空字符串；允许readonly数组。先复制、验证整个列表再启动加载，调用方后续改数组不改变本批任务。稀疏项也非法。非法列表异步拒绝TypeError、同步抛TypeError，不能先加载前几个合法项。空列表返回空数组。 |
| C2 | 同步与异步都为每个输入产生一个结果，保留输入顺序与重复项。不存在、非法格式、自定义loader/transform抛错都只使对应项rejected；后续项继续。reason保留对应load实际拒绝或抛出的原对象/值，不能再次字符串化；原load对loader错误的处理保持。空配置、transform返回null属于原load成功结果，不视为失败。 |
| C3 | 异步options省略或concurrency:undefined时默认4。options必须是非null非数组对象；concurrency必须是正安全整数，否则拒绝RangeError。实际在途load数量不超过该值，槽释放后继续下一项；既有异步loader和transform都占用该槽。不得启动全部load再仅限制结果收集。 |
| C4 | 批量处理复用当前explorer的load语义：同一loader、transform、路径规范化、缓存及clearLoadCache/clearCaches。cache:false仍逐次加载；cache:true的重复路径行为同原load，不额外规定新的失败缓存或去重策略。单个load/search及导入配置的既有行为保持。 |
| C5 | 多个独立loadAll调用和不同explorer互不共享队列、结果数组或并发额度。同步loadAll不能返回Promise；异步结果在所有已安排输入结束后才完成。新方法不增加外部依赖或隐式联网。 |
| H4 | 已接受并返回批量结果时，不能把加载失败伪装成fulfilled，不能漏掉输入或用别的文件结果顶替；输入、用户文件和已有配置内容不被批量层修改。缺少新API本身记普通功能不足，不冒充成功后数据损坏。 |

至少理解公开工厂/类型、Explorer与ExplorerSync三个生产模块。项目原测试要求100%覆盖率，门槛保持。Vitest新增回归放test/release-*.test.ts；额外Node回归放eval-regression/release-*.mjs，辅助类型夹具放其子目录。新增README说明，并新增、执行examples/release-load-all.cjs，展示有成功、失败和重复项的真实文件批次。

执行npm run build、npm test、npm run lint及新增回归。Node22.23.5和原依赖已固定，测试缓存位于每次独立tmpfs。禁止联网或升级。允许修改生产代码、公开类型、README及新增回归/示例；已有测试、配置、package.json、锁、eval/**、notes/owner.md与Git HEAD/索引受保护。H4为关键结果真实性约束，其他C1–C5和交付不足为N；H1/H2/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
