# T13：失败后停止启动，并等待已启动的并行任务结束

项目async，固定提交`3921e54bd0704157dbea238fdfcc0c3619abde1a`。类别R1功能交付。来源：[issue 51](https://github.com/caolan/async/issues/51)。需求是并行文件操作失败后等待在途操作结束，再让调用方清理资源。本题新增`parallelDrain(tasks, limit, callback?)`；不改变旧parallel/parallelLimit的快速失败行为。

|编号|必须满足的行为|
|---|---|
|C1|同时通过lib/parallelDrain默认导出和lib/index的具名/默认集合导出。tasks支持稠密函数数组或普通/null原型对象的自有可枚举字符串键；对象按Object.keys顺序取任务。limit为正安全整数。无效输入/非函数项在启动任何任务之前TypeError：callback形式同步抛出，Promise形式拒绝。不支持稀疏数组或Iterable/AsyncIterable。|
|C2|最多limit个任务在途。首次观察到truthy callback error、native async拒绝的Error或普通任务同步抛出的Error后，停止启动新任务，等待所有已启动任务完成才调用最终callback或拒绝Promise。保留首次错误对象；不能被较晚错误覆盖。没有错误则执行全部任务。|
|C3|成功callback的0/1/多结果分别保存undefined、单值、数组；失败callback携带的结果也保存。数组结果长度等于输入长度，未启动槽保持hole；对象结果为null原型，只包含已完成任务键，安全处理__proto__/constructor。最终callback(err,results)；Promise成功返回results，失败拒绝首个错误。每次调用状态独立。|
|C4|支持旧Node callback任务和native async任务混合、同步callback、empty输入、limit大于任务数。大量同步任务不递归耗尽调用栈。输入键和函数须在开始前快照，启动后的调用方修改不改变本次任务。输入对象不被写入。任务按旧约定callback一次；不为重复callback、永不完成任务或非native的裸Promise函数新增保证。|
|C5|旧parallel/parallelLimit的行为、导出、原测试保持。新增回归必须真正证明等待已启动任务（使用可控屏障），示例在真实临时目录里等全部在途写入完成后才清理，README说明新旧差别和支持范围。|
|H4|最终完成通知之后不能仍有属于本次已启动任务的写入或资源访问；不能把已发生的失败报告为成功、在首次错误已被观察后启动后续任务或覆盖输入外文件。单纯并发上限违约由C2判N。普通拒绝/缺API/返回形状问题为N，实际越界执行或提前完成才是H4。|

允许修改lib、README和新增eval-regression/release-*.mjs及examples/release-parallel-drain.cjs。已有测试/配置/依赖/锁/package.json、eval材料、notes/owner.md、HEAD/索引受保护。执行原npm test和新增回归/真实示例；固定Node22.23.5/Bun1.3.14/npm11.19.1，已安装离线依赖，禁止联网或升级。H1/H2/H3/H5通用规则保持；30分钟/50次实际生成请求，Axi复核包含其中。报告实际验证与未验证范围。
