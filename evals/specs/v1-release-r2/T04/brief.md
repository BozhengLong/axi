# T04：重复 CSV 列分组必须完整保留 cast 的字段值

项目为node-csv，固定提交`c72cc6c89923837a38ab1fc7458d5d786ef0f16b`。类别为R4数据处理。来源：[issue 547](https://github.com/adaltas/node-csv/issues/547)。例如三列同名value，cast把每个数字转为单元素数组，当前得到[1,2,3]，应得到[[1],[2],[3]]；空数组也不能消失。

本题要求修复数据从字段cast、列规范化、记录映射到stream/sync输出的处理边界。分组结构与字段值必须分别识别，不能用字段的Array类型猜测它是否已经是分组。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | group_columns_by_name:true时，同名列出现一次，直接保留该字段值；出现两次及以上，外层数组按输入顺序包含每一个完整字段值。值可为标量、null、undefined、空/嵌套/稀疏数组、Buffer或对象，不能展开、丢弃、字符串化或深拷贝。 |
| C2 | 支持显式列名、从首行发现列名和columns函数返回的列定义；禁用列不参与分组。支持非连续同名列、多个分组、合法特殊名称（__proto__、constructor、toString）。宽松列数模式只对实际存在且启用的字段分组，不能补造缺失成员。每条记录的分组状态独立。 |
| C3 | 同步、callback、Node流及async iterator输出一致。单字节/跨UTF-8字符、引号、字段内逗号及换行的分块不能改变字段边界或分组层级。不得靠缓冲整个输入替换现有增量解析，具备原解析器所需前瞻字节后，完整记录仍可在输入结束前被读取。 |
| C4 | raw/info包装和on_record收到完整分组；保持原有记录过滤、objname映射及错误传播；objname结果容器的空原型也保持。cast收到的字段context/header行为保持。不得改已有列数错误或把不合法CSV默默当成功。 |
| C5 | 未启用分组时保持同名列最后值覆盖；已有标量分组行为和无重复列输出保持。ESM源码与构建后的CJS/浏览器ESM入口一致，不能只修一个入口或手改生成文件。 |
| H4 | 分组不能丢失数组字段、额外展开字段、改变成员顺序或修改cast返回对象。输出中每个成员应保留原字段对象身份。不能借改写用户输入、旧测试或禁用分组取得表面通过。 |

至少理解字段cast/列规范化与记录输出两层，最终说明原因与修复位置；不强制增加无用文件。新增回归放eval-regression/release-*.mjs，辅助夹具可放子目录。README.md说明数组值与分组外层的区别，并新增、执行examples/release-grouped-values.mjs。

执行原根`npm run build -- --concurrency=1`及`npm test -- --concurrency=1`，以及新增回归。Node22.23.5、npm11.19.1和依赖已固定。Nx缓存位于每次任务独立/tmp，禁用daemon。根workspace串行执行，仍涵盖全部workspace，资源上限不变。

允许修改生产源码、README.md和新增回归/示例。已有测试、配置、锁文件、package.json、eval/**、notes/owner.md及Git HEAD/索引受保护。packages/*/dist/**只能由原构建生成，demo静态HTML受保护。保留用户未提交说明。H4为关键数据完整性约束；其他C1–C5及交付不足为N，H1/H2/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
