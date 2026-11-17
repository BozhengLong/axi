# v1正式验收执行与复查

## 当前C2批次（2026-11-17）

`v1-release-p02-r2-20261116T092836Z`完成工程、完整题包资格、三方健康和新C7；T01/v1受上游429影响，按规则INCOMPLETE收尾。见[结果](../verification/2026-11-17-p02-r2-release-results.md)、[逐槽JSON](../verification/2026-11-17-p02-r2-release-results.json)及[C2试用入口](v1-beta1-c2-status.md)。

设施位于`scripts/eval/release-r2/`；正式账本为私有根下`formal-controller/controller-events.jsonl`，不能删除closure重开槽。`final-audit-1/trace-audit.json`绑定7条真实运行、138份Trace和9个视图；`repairs/9a307959101e6228bd3d/`保留唯一修复前后的评分。原始证据不推送公开Git。

复查时先核对哈希链和封存清单，再读每槽review及实际评分。T01/v0当前采用修复目录的新评分，原`runs/T01-v0/final-grade/`仍保存原机判；T01/v1是受上游干扰的UNKNOWN，不能当普通N或PASS。未启动58槽没有模型Trace。

## 旧C1批次（2026-11-16，以下为历史记录）

旧批次`v1-release-20261116`已NO-GO关闭。[结果报告](../verification/2026-11-16-v1-release-acceptance-results.md)说明P-02身份缺陷。不得删除closure或复用额度继续模型任务。方案19允许在工程产品缺陷处停止，因此本轮没有实现或宣布完整正式运行控制器、C7/20题包及三方资格可用。

## 已有设施

- `scripts/eval/release/baseline.ts`：显式指定C目录，对382个冻结文件验哈希；安装、类型检查和预定5次全套测试。它要求输出目录上级有本轮candidate.json。原始退出码与stdout/stderr单独保存。
- `scripts/eval/release/identity-check.ts`：真文件、Agent严格权限和受控普通目标/父目录替换，三工具、三诊断变体各5次。模块诊断不代替真实CLI。
- `scripts/eval/release/identity-cli.ts`：真CLI/PTY、本地固定HTTP回复；四种问题场景及正常/拒绝/symlink对照，每场景5次。输出目录不能已有plan.json，以免覆盖证据。
- `scripts/eval/release/audit.ts`：检查110份原生Trace与本地HTTP请求逐项相符、授权/结果关联、原文件控制和重复槽完整性。
- [工程映射](../../evals/specs/v1-release-v1/engineering-matrix.json)：39项均列出实际状态，不能用名称匹配或旧测试通过代替完整资格。

这些驱动完整采集后正常退出，不以进程退出0表示产品通过。必须读results.json的passed/failed与每份result.json；审计完成也不把行为失败改成通过。当前候选预期产生NO-GO。

## 独立复现P-02

先取得候选`0f4a2c4df87b01d6290ff81dfea2541a5169e2ae`的干净目录，使用Bun1.3.14安装锁定依赖。再从含本轮设施的开发分支运行：

```sh
bun scripts/eval/release/identity-cli.ts /绝对路径/候选C /绝对路径/新的证据目录 macos
```

这是纯本地模拟，不需要真实API key，不调用真实模型。CLI从候选绝对入口启动，任务工作目录是独立临时项目。驱动显式设置本地模拟地址与synthetic key，丢弃宿主模型凭据。每次运行前会固定plan，结束前保存日志和快照再清理临时项目。

Linux本轮使用报告中的固定私有镜像，非root、无公网、2CPU/4GiB、只读根、只读候选挂载与独立可写证据目录。`HOME`和`TMPDIR`指向临时目录。镜像是本机已保存产物，不保证外部机器能按摘要下载；本轮完整命令与环境事实在私有记录中。这里不把它当成公开安装分发包。

## 私有证据

根目录为`~/.local/share/axi-evals/v1-release-20261116/`。完整索引在`TRACE-INDEX.md`；candidate.json冻结源码，environment.json记录平台，closure绑定evidence-manifest的SHA-256。publication.json只记录后续Git同步，不改变执行身份。原始证据不推送公开Git。

本批次110个定向模拟CLI与真实模型额度分开统计。真实模型为0次。C7和60个正式对照槽均未启动，没有相应模型轨迹或可发布成绩。
