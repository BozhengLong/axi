# C3工程验收映射

2026-11-18。C3为`e684620d1fa9109fcbcf442033ed97323cf76716`，sourceHash为`db1ce2d12928db759b4d43a9dc663a5eab490d733673166d33daf04306580391`。39项基础工程证据审计已通过；**RT01–RT12最终五次资格仍在执行，R1整体尚未准入。** T1为空，真实模型0。

本表落实[方案22](../22-unbounded-candidate-acceptance-plan.md)、[方案20/D3](../20-p02-identity-repair-plan.md)及[39项矩阵](../../evals/specs/v1-tools-v1/acceptance-matrix.md)。旧C2成绩未计入；这里只复用驱动，实际结果均来自本批C3。

## 证据入口

私有根S为`~/.local/share/axi-evals/v1-release-unbounded-r3-20261117T132920Z`。`<os>`分别取macos和linux。每项确定性工程场景5次，无择优选择。候选391文件再次核对不变。

| 简称 | S下路径 | 实际范围 |
|---|---|---|
| A | `c3-<os>-check-2` | 干净安装后typecheck及5轮完整测试；每轮208项、1335断言 |
| B | `c3-<os>-engineering-1` | 28组×5，真实文件/模式/用户修改/Git与读取权限、日志失败 |
| W | `c3-<os>-engineering-write-1` | 26组×5，版本、原子发布、取消、子进程和设备元数据 |
| P | `c3-<os>-identity-cli-1`及`identity-cli-extra-1` | 每平台55＋30条实际CLI，原授权失效及合法更新/新授权恢复 |
| G | `c3-<os>-install-cli-1` | checkout和普通项目各5条CLI，每条5项连续任务 |
| I | `c3-<os>-control-cli-1` | 4组×5条CLI，输入/流/退避/复核退避取消与继续 |
| M | `c3-<os>-mutations-1`及`legacy-mutations-1` | 每平台65组正反变体；原生JUnit AssertionError来源核对 |
| E | `c3-adapter-cli-202` | bundle-6上10组×5条三方适配、保护、权限与完整封存 |

A使用R3入口调用未改动的基础驱动；B/W/P/G/I/M使用`release-r2`中未改动的通用驱动并显式传入C3清单。E使用R3执行设施。v0固定963704be97150e268edd3fda484d68e0a18a1f8b，Claude固定2.1.322。两平台使用Bun1.3.14、Node22.23.5和pnpm10.34.9；Linux镜像固定2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1。

审计结果为S下`engineering-audit-r3.json`、`c3-cli-trace-audit.json`及两平台extra目录的`audit.json`。独立核对实际输入/原生请求、SSE、文件/Git保护、5次分母和最终文件哈希。宿主故意设置的AXI_RETRY_WINDOW_MS=1和AXI_HOST_TEST_MARKER未进入任务；隔离环境实际恢复窗口保持600000毫秒。

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

## 当前准入范围

基础工程审计通过后，仍需完成方案22新增RT01–RT12、规定相反实现、最终源码依赖审计及资源核对。当前五次总资格位于S下`r1-final-3`；早期准备失败分别保留，不计为正式能力失败，也不替换为成功记录。

当前结论为R1_PARTIAL。只有工程与RT全部满足并提交、推送后，才能登记20题准入。完整真实Trace、C7及20题成绩仍由后续阶段产生。
