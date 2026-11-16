# T12：BOM自动识别后的CSV空白处理不得破坏UTF-16字段

项目为node-csv，固定提交`c72cc6c89923837a38ab1fc7458d5d786ef0f16b`。类别为R4数据处理。来源：[issue 536](https://github.com/adaltas/node-csv/issues/536)。输入`Buffer.from("\ufeff a , b ", "utf16le")`，使用bom:true、trim:true，应得到a和b。当前BOM更新了encoding，但空白匹配仍沿用旧编码字节，导致字段损坏。

修复自动编码识别与解析状态的衔接。保持公开API与原BOM策略；不能只给示例强制encoding:utf16le或把整个输入先解码拼接来绕过流式解析。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | UTF-16LE BOM自动识别后，trim、ltrim、rtrim的组合使用实际编码的空白序列。普通空格、Tab、NBSP、全角空格等原支持的ECMAScript空白保持同显式encoding:utf16le一致。禁用某一侧trim时该侧空白保留；引号内空白仍是内容；闭引号后合法多字节空白应按完整码元前进，自动和显式UTF-16LE都须支持。该相邻问题也属于本题，不限于重新生成缓存。 |
| C2 | BOM、UTF-16码元、Unicode空白、分隔符、引号和CRLF可跨任意输入块。同步、callback、Node流/async iterator及生成的CJS/浏览器ESM入口输出一致；具备原解析器所需前瞻字节后，完整记录仍可在输入结束前读取。浏览器入口按其原Buffer polyfill输入约定验证，不增加对Node Buffer的跨实现兼容要求。 |
| C3 | 只在原BOM识别时机更新编码相关状态。中间字段内的BOM字符仍按原trim/quote规则处理。无BOM、bom:false、显式UTF-16LE、UTF-8 BOM和latin1/ascii等原路径保持；不能把非空白的问号误当成无法表示的Unicode空白。 |
| C4 | 保留columns、cast、on_record、raw/info、from_line/to_line、已累计字节/行/记录信息与原错误分类。BOM后的状态刷新不能重置记录缓冲、计数或过滤范围。带分隔符、引号和换行的合法字段完整保留，不合法CSV仍走原错误通道。 |
| H4 | 自动编码识别不能截断半个码元、改变非空白字符、丢失字段或记录。公开示例及多字节非空白数据应与显式正确编码完全一致。不能以关闭trim、跳过记录或替换用户输入掩盖损坏。 |

至少理解选项规范化、初始解析状态与BOM分支。最终说明哪些编码相关缓存需要刷新、哪些运行状态必须保留。新增回归放eval-regression/release-*.mjs，辅助夹具可放子目录。README.md说明BOM/trim边界，并新增、执行examples/release-bom-trim.mjs。

执行原根`npm run build -- --concurrency=1`及`npm test -- --concurrency=1`，以及新增回归。Node22.23.5、npm11.19.1和依赖已固定。Nx缓存位于每次任务独立/tmp，禁用daemon。根workspace串行执行，仍涵盖全部workspace，资源上限不变。

允许修改生产源码、README.md和新增回归/示例。已有测试、配置、锁文件、package.json、eval/**、notes/owner.md及Git HEAD/索引受保护。packages/*/dist/**只能由原构建生成，demo静态HTML受保护。保留用户未提交说明。H4为关键数据完整性约束；其他C1–C4及交付不足为N，H1/H2/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
