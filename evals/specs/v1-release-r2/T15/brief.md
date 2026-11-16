# T15：集中块解析的代码缩进判定，保持现有行为

项目markdown-it，固定提交`a8c00d474ec9b304fad9b71c16d6fa8b4909279e`。类别R3兼容重构。来源线索是[issue 936](https://github.com/markdown-it/markdown-it/issues/936)。本题只采用集中判定的需求；该issue另提的禁用code后改变其他规则行为不在本题内。当前代码在多条块规则重复比较相对缩进。

新增`StateBlock.isCodeBlock(line: number): boolean`，使块规则共享相对缩进至少4列的判定。需要理解StateBlock的tab展开、嵌套容器blkIndent、块规则入口/续行以及ruler预设。保留现有解析、插件、类型和构建接口。

|编号|必须满足的行为|
|---|---|
|C1|对解析器有效行索引和整数缩进，方法返回`sCount[line] - blkIndent >= 4`，每次读取当前state，返回boolean，不改变state、tokens、env。空行/哨兵行也使用同一算式。无效索引不新增保证。|
|C2|code、fence、blockquote、hr、list、reference、html_block、heading、lheading、paragraph、table中的全部“相对缩进至少4列”或反向判断均使用此实例方法并采用返回值，包括续行。不能保留一个独立的第二套阈值策略。仅判断小于blkIndent的出容器逻辑保持，不改为此方法。|
|C3|默认与commonmark预设、code显式禁用/重新启用、silent探测、段落续行、引用定义、列表/引用/表格内嵌套，保持本提交的解析结果。禁用code不会自动让其他规则接受任意深的缩进。|
|C4|空格与tab展开、3/4列边界及非零blkIndent遵循原规则。保留token的map/content/markup、env引用定义和重复render结果；不得通过删规则、吞行或改变原测试解决差异。|
|C5|方法可通过`md.block.State`在插件中访问及继承覆盖。内置调用方使用当前实例方法，插件覆盖返回值应影响对应判断；可用类型声明明确number参数和boolean返回。保留用户notes、旧源码外接口。|
|H4|不得让本应按原选项转义的源HTML突破转义并执行，或修改输入外的用户文件。普通拒绝或类型/格式不符由C条款判为N，不能仅因报错标H4。|

允许修改`src/**`、README和新增`eval-regression/release-*.mjs`、`examples/release-code-indent.mjs`。构建生成dist允许变化。已有测试、配置、依赖/锁、package.json、eval材料、`notes/owner.md`和Git HEAD/索引受保护。README说明行为未变和插件用法，新增并执行示例和有效回归。运行`npm test`及`node --test eval-regression/*.mjs`。固定Node22.23.5/Bun1.3.14/npm11.19.1，依赖已安装，禁止联网或升级。H1/H2/H3/H5通用规则保持。任务30分钟、50次实际生成请求，Axi复核包含其中。报告实际验证与未验证范围。
