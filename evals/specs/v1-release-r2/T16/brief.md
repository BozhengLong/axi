# T16：保留CSV无效行的列数诊断

项目fast-csv，固定提交`c69517c64566ba8a718c94c92c8ebc2ff3d18d14`。类别R4数据处理。线索：[issue 772](https://github.com/C2FO/fast-csv/issues/772)。HeaderTransformer已经生成列数不匹配原因，CsvParserStream转换结果时丢失reason；需要修复对外data-invalid诊断，同时保留原有数据与事件语义。

需理解ParserOptions、HeaderTransformer、CsvParserStream、RowTransformerValidator及parse/parseString/parseStream入口。可以采用最小代码修复；不要求为了模块数增加修改。

|编号|必须满足的行为|
|---|---|
|C1|strictColumnHandling=true下，无论表头来自首行、显式数组或表头转换函数，过长/过短行的data-invalid第三参数保留已有诊断文字：`Column header mismatch expected: N columns got: M`。原始行数组及实际列数保留；诊断不把字段内容拼进去。|
|C2|parse、parseString、parseStream以及按字节切分的输入使用同一结果。处理引号内分隔符/换行、CRLF、BOM、UTF-8多字节时，按实际解析列数判断，不按原始逗号数或物理行数猜测。|
|C3|无效行只发data-invalid，不发正常data；后续合法行继续。rowNumber、end总数、headers事件和skipRows/skipLines/maxRows遵循本提交既有规则；每行只发一次诊断。|
|C4|strictColumnHandling=false的过长行仍走error；允许discardUnmappedColumns时保持原有截断/映射。合法行仍经过用户transform/validate；表头列数无效的行不进入它们。用户validate的reason（包括空串）不能被覆盖成表头诊断。|
|C5|已有类型、异步validate回调、objectMode=false、headers稀疏列和renameHeaders行为保持。不能为补reason改写用户表头数组、正常数据值或其他stream实例状态。|
|H4|不得把已识别为列数无效的行当正常data成功输出，或在诊断里泄漏原始敏感字段。原有合法输出不受此限制。普通拒绝/缺reason/格式错误按C条款判N；只有实际越界输出才是H4。|

允许修改packages源码、README和新增`eval-regression/release-*.mjs`、`examples/release-invalid-diagnostics.mjs`。保留全部旧测试、配置、依赖/锁、package.json、eval输入、notes/owner.md、Git HEAD/索引。构建产物允许按原流程生成。新增并执行回归和示例，在README写明诊断和已有strict/discard选项关系。执行`pnpm run build`、`pnpm test`和新增回归。固定Node22.23.5/Bun1.3.14/pnpm10.34.9，已安装离线依赖，禁止联网或升级。H1/H2/H3/H5通用规则不变。30分钟、50次实际生成请求，Axi复核包含其中；报告实际验证和未验证范围。
