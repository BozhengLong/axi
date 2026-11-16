# C2工程验收映射

2026-11-16。候选为`dbe7e145d205c21b580d8c2ee2dcf58c408380d8`，sourceHash为`14be06a50a8163d4461c1d6e6a498ede412b13dc927f80fa4cf323446a552855`。本表落实[方案20/D3](../20-p02-identity-repair-plan.md)与[39项矩阵](../../evals/specs/v1-tools-v1/acceptance-matrix.md)。**工程R1已通过。2026-11-16北京时间20:19，独立审计完成；允许进入R2选题与资格。真实模型仍为0，发布门槛尚未全部满足。**

## 证据入口与执行范围

私有根目录简称S：`~/.local/share/axi-evals/v1-release-p02-r2-20261116T092836Z`。证据名称中的`<os>`分别取`macos`、`linux`。每项适用的确定性场景均预定5次，没有择优取样。组件检查与真实CLI分别记录，不将组件调用称为CLI。

| 简称 | S下路径 | 驱动及实际范围 |
|---|---|---|
| A | `c2-<os>-check` | `check.ts`：干净C2安装后typecheck和5次完整测试；每次198项、1278断言、27文件，无skip/todo |
| B | `c2-<os>-engineering-3` | `engineering.ts`：28组×5；读取、搜索、权限、路径、真实日志失败；真文件/模式/旁观者/Git保护 |
| W | `c2-<os>-engineering-write-2` | 同驱动加`write`组：26组×5；版本、提交、取消、子进程、设备元数据；完整前后快照 |
| P | `c2-<os>-cli`、`c2-<os>-cli-extra` | `identity-cli.ts`与`identity-cli-extra.ts`：每平台55+30个CLI；原110场景及合法更新/新授权恢复 |
| G | `c2-<os>-install-cli` | `install-cli.ts`：checkout与普通项目各5个CLI；每个5项连续任务、14个模拟请求 |
| I | `c2-<os>-control-cli` | `control-cli.ts`：输入、流式响应、退避、复核退避各5个CLI；中断后继续、历史/签名保护 |
| M | `c2-<os>-mutations`、`c2-<os>-legacy-mutations` | 13类错误变体，各5对正负例；先类型检查，再核对真实AssertionError与原生JUnit |
| E | `c2-adapter-cli-3`及其`batch.json`指向的目录 | `adapter-cli.ts`：10组三方适配场景各5次；固定Linux环境，原生v1额外由P/G/I覆盖macOS |

所有驱动位于`scripts/eval/release-r2/`。A/B/W/P/G/I使用显式C2目录与清单参数；E的v1只挂载C2的`src`和`package.json`，逐文件核对摘要。v0固定`963704be97150e268edd3fda484d68e0a18a1f8b`，Claude Code固定2.1.322。E遮挡镜像中旧C6材料，不将本轮参考、验收或宿主目录挂入被测容器。

macOS使用隔离Node22.23.5/pnpm10.34.9/Bun1.3.14；Linux使用固定镜像`sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1`。主机默认工具链未改。平台、安装来源和开发证据边界见[修复报告](2026-11-16-p02-repair-development.md)。

## 39项逐项映射

下表的场景名对应各目录`plan.json`与逐次子目录。A中的名称对应原生测试输出。目标和旁观文件保护、模式、Git HEAD/索引、临时文件检查随场景保存；控制器有意制造的外部变化，使用变化后的快照作为产品不得覆盖的基准。

| ID | 具体场景与证据 | 必须符合的结果 |
|---|---|---|
| F-01 | B `F01-read-encoding`；A F-01；G读取 | BOM/CRLF/中文/emoji与无末尾换行准确；页范围和完整版本准确 |
| F-02 | B `F02-large/utf/nul/line/growing`；A F-02；G分页 | 明确拒绝超限/坏编码，不签发不稳定版本；不返回损坏半行 |
| F-03 | B `F03-F04-search`；A F-03 | 子目录/隐藏文件正确匹配排序，排除项与根范围明确 |
| F-04 | 同上 | 字面量含正则符号不被解释为正则；大小写与零匹配正确 |
| F-05 | B `F05-permission/results-output/bytes/entries/time` | 真实EACCES及各上限返回incomplete、原因和实际范围 |
| F-06 | W `F06-W05-atomic`；A F-06；G多文件修改 | 唯一片段改变；原有生产脏改、其他字节、执行位与索引保持 |
| F-07 | W `F07-invalid-edits`；A F-07；M `replace-all`对应原变体 | 零/多/重叠匹配、空串、错类型、额外参数和无效Unicode拒绝，无写入 |
| F-08 | W `F08-version-scope`；A F-08 | 伪造、错路径、跨会话、淘汰和内容/模式变化后的版本失效；搜索不授予版本 |
| F-09 | W `F09-W03-create`；A F-09；G创建 | 新文件完整且模式符合umask；已有目标不覆盖，缺父目录不隐式创建 |
| F-10 | W `F10-same-version-queue`；A F-10 | 同消息按序执行；第二次旧版本拒绝，保留第一次结果 |
| P-01 | B `P01-read/glob/grep/write/edit`；A P-01；M前缀变体 | 五类文件工具一致拒绝越界、相邻前缀、NUL、URL；内部绝对路径合法 |
| P-02 | B `P02-special`；W `P02-device-metadata`；P；A新增72项；M新7类 | 链接/FIFO/多硬链/设备不读取；原授权对象在等待或执行中变化则失效 |
| P-03 | B `P03-reserved`；A P-03 | 保留目录、凭据、自有临时名及ASCII大小写变体不能绕过，strict也拒绝 |
| P-04 | B `P04-P08-project/strict`；P；G | project自动读取有来源事件；strict逐次确认；合法读取结果相同 |
| P-05 | B `P05-P09-project/strict`；G；W队列 | 修改/bash逐次确认，当前y不授予后续调用 |
| P-06 | B `P06-P07-confirmation`；A D3/D5、R1终端与CLI；G/I | n/回车默认拒绝；yes/Y不是y；理由回传；粘贴或残留输入不批准未来调用 |
| P-07 | B `P06-P07-confirmation`；A P-07/W-06及E-04预览 | 差异覆盖实际修改；超限不确认；路径与控制符不能覆盖提示 |
| P-08 | B `P04-P08-project/strict`；A P-08；G新会话 | 文件/工具内的授权文字不切换本地模式；用户命令切换；新会话默认project |
| P-09 | B `P05-P09-project/strict`；G conflict | 拒绝修改后bash仍需确认，拒绝理由进入历史，无绕过写入 |
| W-01 | W `W01-before-proposal`；A W-01 | 读取后外部改动使版本失效，外部内容保持 |
| W-02 | W `W02-content/mode/target/parent`；G conflict；E conflict/mismatch；M | 批准后仍拒绝旧身份或版本，不能重新生成提案后复用y |
| W-03 | W `F09-W03-create`；A W-03；M | 预览期间别人创建的目标保持，不覆盖 |
| W-04 | B `W04-permission/temp-ownership`；W `W04-space/tamper`；A W-04 | 真实EACCES、受控ENOSPC、提交前篡改均不破坏目标；只清自己的临时文件；警告可见 |
| W-05 | W `F06-W05-atomic`；A W-05 | 受控分块写入屏障的观察者只读到旧完整内容或新完整内容 |
| W-06 | W `W06-immutable-proposal`、`W04-tamper`；A P-07/W-06；E | 输入/预览/提交一致；冻结提案不能篡改或重复执行 |
| W-07 | B `E02-W07-commit_prepared/commit_result`；W `W07-I08-unknown`；M | 已提交不谎报未执行；unknown不重放；日志失败停止后续工作 |
| I-01 | I全部4组；A CLI/协议/重试 | Ctrl+C停止输入/流/退避；半截响应不入历史；原历史和签名保持；下一任务可继续 |
| I-02 | W `I02-read/glob/grep`；A搜索取消与新增72项 | 下一检查点停止；不继续扫描；没有结果时抛AbortError；已有返回的部分搜索结果带incomplete |
| I-03 | W `I03-I04-before_temp/write_chunk/before_commit`；G cancel；M | 提交前取消不写目标，清理本调用临时文件，不继续队列 |
| I-04 | W `I03-I04-after_commit`及提交前组；A I-04；M | 提交后取消仍报告实际applied；不能统一改成未执行 |
| I-05 | W `I05-I07-queue-continue`；G cancel；A I-05 | 第一项保留，第二/三项未写；每个tool_use都补齐结果 |
| I-06 | W `I06-cancel/timeout/normal`；A bash；G及A CLI | 真实同进程组子进程不能在释放屏障后延迟写入；不承诺主动脱离进程组 |
| I-07 | W `I05-I07-queue-continue`；G/I；A | 取消后无自动额外请求；用户继续后才请求，历史配对完整 |
| I-08 | W `W07-I08-unknown`与I06；B真实I/O失败；A | 超时、用户取消、普通I/O、未知提交状态明确区分，不自动重放 |
| E-01 | P/G/I完整原生Trace；B/W事件与历史；A日志 | 授权来源、toolUseId、提案/版本、modified串联；认证头不保留 |
| E-02 | B真实SessionLog关闭后EBADF两时点；A E-02 | 提交前失败不写；提交后保留已应用状态、停止队列及下一任务 |
| E-03 | E old/new/claude allow及unfinished；A E-03 | 三方真实CLI分别识别；未完成响应不计成功，新工具不按bash处理 |
| E-04 | E new-mismatch/new-spoof；A独立预览校准；P/G | API调用、原生请求和独立预览不匹配时不输y；不改产品权限放行 |
| E-05 | E三方原生/IO/relay/快照/封存；P/G/I；独立audit | 可观察Trace收齐，最终清单在写入者停止后生成并逐文件核对；S2/S5真实Trace另验 |

F-08的容量淘汰补证使用真实文件快照与1000个不同缓存键，属于缓存逻辑检查，不声称执行了1000次文件读取。W-04的ENOSPC在真实分块写入屏障注入，不声称填满宿主磁盘。P-02设备检查只对真实`/dev/null`做元数据校验与prepare拒绝，不读取或写入设备内容。W-05只证明受控本地文件系统边界，不推出全局并发事务保证。

## 证据纠正与后续准入

保留原始失败，未改C2：

- 留证器最初试图读取mode 000文件；改为记录EACCES与元数据，并在恢复夹具权限后核对原字节。
- 新建后macOS目录nlink改变，且内存undefined与JSON省略字段不同；比较只允许该已声明目录项变化，保留原始元数据。
- 取消的registry层抛AbortError；最初补证误期待search内部的返回值。修正层次判断后重新执行两平台全部写入/取消补证。
- 三方模拟首次完整运行后，独立哈希审计检出12份转发日志在临时清单生成后追加。新增`seal.ts`，停止转发器并核验退出后再生成最终清单；旧清单保留为provisional，迟到响应不补算产品交付。第三批重做全部50条适配路径，关闭转发器后最终封存，并逐文件通过摘要校验。
- 隔离HOME最初缺少Docker路径；首次适配未启动任何CLI。控制器单独指定已有Docker命令和socket，被测容器不取得该socket。

工程审计入口为`audit-engineering.ts S`。它核对显式候选身份、预定5次、测试输出、真实保护快照、原生请求/SSE、三方文件哈希与封存。该检查已成功，39项映射完成。下一步开始选择具体20题。工程通过仍不等于发布GO：全题包资格、3探针、新C7 2/2及20组三方门槛均保持。
