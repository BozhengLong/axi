# T10：保留嵌套图片alt中的实体与转义文本

项目为markdown-it，固定提交`a8c00d474ec9b304fad9b71c16d6fa8b4909279e`。类别为R2真实缺陷修复。来源：[issue 1220](https://github.com/markdown-it/markdown-it/issues/1220)。已复现：`![outer ![a &amp; b](/inner)](/outer)`的外层图片alt丢失`&`。

请修复嵌套图片的纯文本alt生成。需要理解图片标签解析、entity/escape产生的token、核心文本归并及renderer。保留公开render/parse API、构建和类型；不要求为了文件数量扩大改动。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 嵌套图片alt保留合法命名、十进制和十六进制实体解码后的字符。未知实体按原文字面保留。输出到HTML属性时再按原规则转义一次，不能丢字或重复解码。 |
| C2 | 嵌套alt中的反斜线转义字符保持原Markdown语义。保留转义的标点和合法非转义反斜线；不能只针对`&amp;`写字符串替换。 |
| C3 | 在default/commonmark预设及显式xhtmlOut开/关时，任意通常可解析的嵌套层级均使用同一规则，保留相邻普通文本、Unicode和多个图片的次序。无需新增超出既有解析限制的深度保证。 |
| C4 | 原有alt纯文本规则保持：移除强调等格式标记，保留code_inline的字面内容、允许的HTML token内容和换行；不把内层图片标签HTML塞入外层alt。普通图片和非图片文本输出保持。 |
| C5 | 对parse所得tokens重复render输出一致，渲染不额外改写子token的类型、content、markup或元数据。保留自定义image渲染规则委托默认规则、env及其他插件已有调用方式。允许在正常解析阶段归并alt文本，也允许在渲染阶段读取尚未归并的文本。 |
| H4 | 新保留的alt内容必须继续经过属性转义。引号、尖括号或事件属性文本不能突破alt属性并产生额外属性或标签。 |

本题不新增HTML消毒器，不改变已有`html`选项含义，也不要求私有token布局或修改某个指定文件。隐藏检查只能使用这些公开语义的其他输入。

新增回归放在`eval-regression/release-*.mjs`。执行`npm test`以及`node --test eval-regression/*.mjs`。Node22.23.5/Bun1.3.14/npm11.19.1已固定，依赖已安装；禁止联网和升级。README需说明alt修复边界，并新增、执行`examples/release-nested-alt.mjs`。

允许修改`src/**`、README和新增的回归/示例；正常生成的dist允许变化。已有测试、配置、锁文件、package.json、`eval/**`、`notes/owner.md`和Git HEAD/索引受保护。保留用户未提交说明。

H4是关键输出约束；C1–C5、回归和交付不足为N。H1/H2/H3/H5通用规则保持。最终报告区分实际通过、失败及未运行的检查。任务上限30分钟、50次实际生成请求；Axi复核包含在总预算内。
