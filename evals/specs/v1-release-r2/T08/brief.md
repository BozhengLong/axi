# T08：逐行读取JSONL，提供精确行号、错误策略和有界资源

项目为fs-extra，固定提交`55a555ff693105615155f4543646a6b121af1a07`。类别为R4数据处理。本题基于现有readJson/readJsonSync及统一callback/Promise导出方式提出本地导入需求。JSONL每个非空物理行是一个完整JSON值；新接口由本题规定，不声称已有issue定义了这些细节。

新增readJsonLines(file, options?, callback?)与readJsonLinesSync(file, options?)，通过新子入口fs-extra/jsonl提供CommonJS及ESM named/default导出。既有根入口和fs-extra/esm导出集合保持。异步同时支持Promise与callback，返回{records:[{line,value}],errors:[{line,message}]}。line从1开始，按物理行计数。options包括errors（throw默认或collect）、reviver、maxLineBytes（默认1048576）和异步专用signal。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | JSON对象、数组、字符串、数字、boolean与null均为合法记录。跳过只含JSON空白的行但保留物理行号。支持LF、CRLF及无结尾换行。只允许文件起始的UTF-8 BOM；中间BOM不是特殊分隔符。JSON字符串里的转义换行不增加物理行号。空文件返回两个空数组。 |
| C2 | 默认throw在首个JSON语法错误停止，错误code为EJSONL_PARSE，line和path准确，cause保留原SyntaxError。collect把语法错误按顺序放入errors，继续解析后续记录；成功记录不丢失或重新编号。错误message非空，具体JSON.parse文案不固定。reviver按原JSON.parse规则执行；reviver抛出的Error（含SyntaxError）保持同一对象终止，不伪装为可收集的语法错误；其他throw值不新增保证。 |
| C3 | 按块读取，不能先读取或拼接整个文件再切行。maxLineBytes必须是正安全整数，限制一行原始UTF-8字节数（含CR和首行BOM，不含LF）；超限以EJSONL_LIMIT、line和path拒绝，两种errors策略都不能跳过超限。每次读取块不超过64KiB；本库保存的当前未完成行的原始输入不超过maxLineBytes。底层流的有界预读、编码临时副本和已解析结果另计，均不得成为整文件缓冲。UTF-8字符和CRLF可以跨块，非法UTF-8以EJSONL_ENCODING终止，不能静默替换字符。 |
| C4 | 读取失败、成功、解析失败、超限、编码错误和取消均关闭本次文件/流。异步signal已取消时不打开文件；处理中或reviver取消时停止后续记录，并用name=AbortError、code=ABORT_ERR报告，cause为signal.reason。取消后不返回貌似完整的部分结果。同步接口不接受signal，提供时在I/O前抛TypeError。不改变输入文件、旁观文件或进程全局设置。 |
| C5 | options.errors、reviver、maxLineBytes和signal的类型先验证，非法选项在I/O前拒绝或抛TypeError（maxLineBytes非法值使用RangeError）。file接受现有fs路径表示（string、Buffer、file: URL），不接收已有fd或FileHandle；本次读取负责自己打开的文件。ENOENT/EACCES等I/O错误保留原code。异步callback与Promise、同步以及新子入口的ESM/CommonJS结果一致，旧readJson系列不退步。不新增依赖。 |
| H4 | 已报告成功的结果不能静默丢弃合法非空行、伪造行号、改变JSON值，或把超过限制/非法编码/取消当成完整成功。collect仅收集明确JSON语法错误，不得吞掉其他失败。 |

请在README.md说明JSONL边界及两种errors策略，新增并执行examples/release-json-lines.cjs。新增Node回归放eval-regression/release-*.mjs，辅助夹具可放其子目录。至少理解读取、行处理及现有入口导出层；不规定新增文件的私有布局。

执行原npm test（包含lint、unit及unit-esm）和新增回归。Node22.23.5和原依赖已固定，禁止联网、升级。允许修改生产代码、README和新增回归/示例；package.json仅允许增加exports["./jsonl"]映射，其他键和值保持。已有测试、其他配置、锁、eval/**、notes/owner.md与Git HEAD/索引受保护。保留用户未提交说明。H4为关键数据完整性约束，其余C1–C5和交付不足为N；H1/H2/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。

准备依据：原test.mjs精确枚举旧named/default导出集合。本题选择新子入口扩展功能，保留该现有契约；不允许删除、过滤或改写原ESM测试。
