# T05：在不改变数据映射的前提下转换 CSV 显示表头

项目为fast-csv，固定提交`c69517c64566ba8a718c94c92c8ebc2ff3d18d14`。类别为R1多模块功能。来源：[issue 1161](https://github.com/C2FO/fast-csv/issues/1161)：对象使用camelCase键，导出文件需要可读表头，同时保留原数据键。

新增format选项`headerTransform?: HeaderTransformFunction`，公开导出类型`(this: void, header: string, index: number) => string`。这是同步的显示转换，不替换原有行transform，也不改变逻辑列名。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 公开选项和TypeScript类型正确。省略或undefined表示不转换；其他非函数配置在构造时抛TypeError。每个实际输出的表头字段调用一次，按原列顺序传入原逻辑名及零基索引；普通严格函数的this为undefined，参数只有这两个。返回值必须是string，否则通过流错误通道报告TypeError。 |
| C2 | 显式headers与自动推导headers均支持对象、普通数组和键值对数组。自动数组首行仍按原规则作为表头消耗；显示改名不能把它重复当成数据。空名或重复显示名合法。数据字段查找始终使用原逻辑列名，列顺序不改变。 |
| C3 | 显示名经过现有CSV引号、转义、分隔符、换行、BOM及NUL处理。quoteHeaders/quoteColumns的对象映射仍以原逻辑列名为键，数组映射仍以原列索引为准。不改变现有字段转义规则。 |
| C4 | 仅实际输出表头时调用新函数。writeHeaders:false、无headers、行transform过滤或空流的行为按原规则保持；alwaysWriteHeaders在原规则要求输出空流表头时也应用转换，包括该旧选项会覆盖writeHeaders:false的情形。保持includeEndRowDelimiter和原行transform的同步、回调异步及过滤语义。 |
| C5 | 新函数抛出的Error保持同一对象，经format流的error通道报告；该流不能成功end或把坏表头当成完整输出。writeToString/writeToBuffer拒绝同一Error。异步行transform回调和空流flush也必须捕获新函数错误，不能成为uncaughtException。已有调用方data监听器抛错保持原有错误通道：当前同步format路径会报告同一stream error，不要求改成uncaughtException；不能吞掉或包装成新的表头错误。本题不扩大旧write快捷函数的全部错误事件次数保证。 |
| H4 | 显示转换不能改变数据行的值、数量、列顺序或原对象键的查找。不能通过改写调用方headers/rows完成改名。行transform本身原有的修改效果不属于本项新增保证。 |

至少涉及公开类型、选项处理及格式化三个生产模块。不要求某种内部布局。保持所有旧测试；新增回归放在`eval-regression/release-*.mjs`，辅助文件和类型验证放其子目录。实际验证公开类型、异步错误、空流与普通数据对照。README.md解释显示名与逻辑名，并新增、执行`examples/release-header-transform.mjs`。

执行原`pnpm run build`和`pnpm test`，以及新增回归。运行时Node22.23.5、pnpm10.34.9、依赖已固定。环境预先在.npmrc声明package-manager-strict=false与manage-package-manager-versions=false，使用固定pnpm而不下载packageManager声明的版本。隔离环境用NODE_PATH=/task/node_modules/.pnpm/node_modules适配pnpm的安装路径；Nx和文档构建缓存位于每次任务的临时目录。不得联网、升级依赖或修改这些环境设置。

允许修改生产代码、公开类型、README.md及新增回归/示例。已有测试、配置、package.json、锁文件、eval/**、notes/owner.md及Git HEAD/索引受保护。保留用户未提交说明。H4为关键数据完整性约束，其余C1–C5和交付不足为N；H1/H2/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
