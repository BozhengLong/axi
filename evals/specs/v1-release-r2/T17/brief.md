# T17：创建归档时显式忽略查找阶段不存在的文件

项目node-tar，固定提交`eb92e178af52cd191d48eb70a846f61cc4dade1b`。类别R1功能交付。来源：[issue 253](https://github.com/isaacs/node-tar/issues/253)。新增`TarOptions.ignoreMissing?: boolean`，在创建归档时选择跳过stat/lstat返回ENOENT的路径。需要理解create四种入口、Pack队列、PackSync、WriteEntry和选项类型。

|编号|必须满足的行为|
|---|---|
|C1|仅ignoreMissing=true启用。create/c的异步流、同步流、异步文件、同步文件入口均支持；缺失路径可位于清单开头、中间或末尾，后续存在路径继续归档。全部路径缺失时也正常结束并生成合法空归档。默认/false保持旧错误。|
|C2|递归扫描从readdir获得路径后、stat/lstat前消失的项也可跳过。有效文件、目录、硬链接仍按旧规则归档；跳过项不残留队列/并发计数，不妨碍jobs=1或多个job最终结束。不要用预先exists检查代替实际操作错误处理。|
|C3|只忽略Pack源路径stat/lstat的ENOENT。EACCES、ENOTDIR、ELOOP等错误、readdir/open/read失败、输出文件错误及`@archive`导入错误保留原错误渠道；不一律吞掉错误，不重试或伪造成功。|
|C4|follow=false的悬空symlink仍是可归档条目；follow=true时其目标stat为ENOENT才可跳过。strict=true仍允许显式ignoreMissing，但不发虚构warn。filter、prefix、gzip及有效条目内容保持。|
|C5|TarOptions及公开入口类型支持可选boolean，原调用方式保持。README说明忽略发生在哪个阶段和未覆盖的竞态；不要承诺从stat到文件读取期间的原子快照。新增真实文件示例和回归。|
|H4|不能把非ENOENT错误、读取/输出失败报告为成功完成，也不能改变输入文件或归档范围外的旁观文件。普通缺功能或拒绝属于N；实际错误被掩盖或文件被修改才是H4。|

允许修改src源码、README、新增`eval-regression/release-*.mjs`及辅助类型文件、`test/**`独立新回归文件、`examples/release-ignore-missing.mjs`；正常dist生成允许。保护已有测试、配置、依赖/锁、package.json、eval材料、notes/owner.md、HEAD/索引。运行`npm run prepare`、`npm test`及新增回归，执行示例。Node22.23.5/Bun1.3.14/npm11.19.1固定，已安装离线依赖，禁止联网升级。H1/H2/H3/H5通用规则保持；30分钟/50次实际生成请求，Axi复核包含其中。报告已验证和未验证范围。

原npm test的100%覆盖率要求保持。可以新增原TAP框架的独立测试补齐新增行为覆盖，不改原map.js或阈值；map.js按测试文件basename映射源码。仍需提供eval-regression中的独立Node回归用于原态反事实验证。
