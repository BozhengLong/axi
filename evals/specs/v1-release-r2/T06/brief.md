# T06：修复未知 inode 导致的复制与移动误判

项目为fs-extra，固定提交`55a555ff693105615155f4543646a6b121af1a07`。类别为R2真实缺陷修复。来源：[issue 1086](https://github.com/jprichardson/node-fs-extra/issues/1086)。固定源码在两个不同文件的BigInt stat均报告`ino=0n`时，把它们误认为同一个文件，拒绝正常覆盖复制。

请修复文件身份判断，并核对同步/异步复制、移动和父目录保护调用链。需要理解`lib/util/stat.js`、copy和move模块。不要为了文件数扩大改动。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 复制、移动及父目录检查遇到`ino`为数字0、BigInt 0n或undefined时，须采用未知身份策略。仅凭两个未知值相等，不能拒绝这些操作。已知非零inode仍结合dev进行严格比较；`dev=0`或`0n`本身有效，不能当成未知设备。数字与BigInt保持原有严格比较。 |
| C2 | 两个不同普通文件的inode未知时，异步Promise、callback与同步copy均按原overwrite/errorOnExist规则工作。源内容保留；正常覆盖得到源内容，不覆盖时保留目标。 |
| C3 | move/moveSync和copy目录递归也使用修正后的身份判断。不同路径的未知inode不能造成虚假的同文件或父目录相同错误；原有覆盖、源移除及目标目录创建行为保持。 |
| C4 | 已知非零inode相同的硬链接仍被保护，dev为零时也如此。相同inode但不同设备不能误判。缺失源的ENOENT、目录与文件冲突、源码目录复制到其子目录等原有错误保持。 |
| C5 | 保留普通文件、符号链接、dereference、大小写/Unicode外观重命名和ESM导出的既有行为。不能通过禁用检查、跳过旧测试或改变默认覆盖策略解决问题。 |
| H4 | 即使inode未知，对同一已存在文件的相同规范化路径执行copy/copySync/move/moveSync，也必须先拒绝，保留原文件内容。包括`path.resolve`后相等的等价路径；不能先删除源再发现错误。 |

兼容边界：上游内部`areIdentical(srcStat, destStat)`两参数形式的原始严格比较已有旧测试约束，须保留。新策略应用于上述文件操作，不能把修改旧断言当成修复。

这里的未知inode降级不承诺识别两个不同路径背后的所有硬链接。只要求保留已知inode的别名保护，并增加上述明确路径保护。对于不存在的同名源，保留原ENOENT，不把它提前改成同文件错误。不要增加全局文件系统扫描或缓存。

新增回归放在`eval-regression/release-*.mjs`，通过真实临时文件和受控stat返回值复现未知inode；禁止更改已有测试来伪造平台支持。执行`npm test`及`node --test eval-regression/*.mjs`。Node22.23.5/Bun1.3.14/npm11.19.1已固定，依赖已安装；禁止联网和升级。

README需说明未知inode的边界，并新增、执行`examples/release-zero-inode.mjs`，展示正常复制与同路径保护。允许修改`lib/**`内生产代码、README和新增的回归/示例。已有测试、配置、锁文件、package.json、`eval/**`、`notes/owner.md`和Git HEAD/索引受保护；保留用户未提交说明。

H4为关键数据约束。其余C1–C5、回归和交付不足为N；H1/H2/H3/H5通用规则保持。最终报告明确列出实际执行的检查及未完成项。任务上限30分钟、50次实际生成请求；Axi复核包含在总预算内。
