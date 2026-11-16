# T01：为可配置CLI发行版声明子命令可用性

项目为Commander，固定提交`a5a7dc084d4d2b7932e85ca049c5204e50a2c721`。类别为R1多模块功能。来源：[issue 2613](https://github.com/tj/commander.js/issues/2613)：应用希望保留同一套模块化命令定义，再按发行版选择可用命令。hidden仅隐藏帮助，不能禁止调用；本题需要独立的可用性设置。

新增公开API：`command.enabled()`返回boolean；`command.enabled(value: boolean)`设置状态并返回原Command用于链式调用。默认true。其他显式参数（包括undefined）抛TypeError且不改变原状态。可用性在调用parse/parseAsync前设置，本题不规定解析过程中修改状态的效果。

| 编号 | 必须满足的行为 |
|---|---|
| C1 | 新API及TypeScript声明正确。状态属于当前Command，互不串扰；父命令状态不覆盖子命令自己的状态。commands数组仍保留全部原对象及顺序，允许以后重新启用。 |
| C2 | 经父命令调用已禁用子命令的名称或alias，包括`cmd --help`、`help cmd`和禁用父级下的嵌套路径，均在目标动作/外部进程及preSubcommand/preAction hooks之前拒绝。使用既有CommanderError机制，code为commander.commandDisabled、exitCode为1，消息包含目标的规范命令名。已知禁用名称不能被默认或通配命令接管。 |
| C3 | 禁用的默认子命令和`*`通配子命令不被隐式选择；已启用默认/通配行为保持。禁用默认命令后，根action和根选项按原有规则处理，不被失效的默认入口截走。 |
| C4 | 默认Help.visibleCommands、帮助正文和未知命令建议不列出禁用名称/alias。hidden与enabled独立：hidden但enabled仍可调用；重新启用不改变hidden。显式注册的help命令也遵守enabled；自动生成的隐式帮助入口继续由原addHelpCommand配置控制。 |
| C5 | 原有名称/alias冲突检查仍检查全部注册命令，不能因禁用而允许重复定义。保持启用命令的普通参数、选项、异步action、外部可执行子命令、帮助排序及exitOverride/输出配置。新功能不删除命令定义，也不重新定义全部带子命令的参数语法。 |
| C6 | 同一命令树在多次parse/parseAsync之间切换状态时，始终使用当前设置；错误后重新启用可恢复。解析的已保存状态不能恢复旧enabled值，帮助查询不能修改可用性。 |
| H4 | 当enabled(false)已经接受且getter返回false时，不得仍通过父级入口执行该子命令的action或启动其外部可执行文件。缺少API或明确拒绝配置是普通功能不足，不把这种情况冒充“已禁用却仍执行”。 |

这个功能控制应用公开的子命令入口，不是安全沙箱。根命令自身的action仍可正常使用；应用直接调用一个Command对象的parse属于直接入口，不用enabled充当权限检查。只对通过父命令分发的注册子命令应用上述限制。应用自定义帮助渲染器可以自行展示元数据，不能因此放松实际分发检查。

至少理解命令分发、Help和公开类型三个生产模块。新增Node回归放在`eval-regression/release-*.mjs`，辅助夹具可放其子目录；新增类型回归放在`eval-regression/types/`。要求有一个真实可执行子命令对照，证明禁用时没有动作或进程副作用，而不是仅检查帮助字符串。

执行`npm test`、`npm run check:type:js`、`npm run check:lint`以及新增回归。类型回归应实际用TypeScript编译验证getter、链式调用和错误参数。Node22.23.5/Bun1.3.14/npm11.19.1及依赖已固定，禁止联网与升级。`Readme.md`说明可用性、hidden及直接入口边界，并新增、执行`examples/release-command-enablement.mjs`。

允许修改生产代码、公开类型、`Readme.md`以及新增回归/示例。已有测试、配置、锁文件、package.json、`eval/**`、`notes/owner.md`和Git HEAD/索引受保护。保留用户未提交说明。H4为关键执行约束，其余C1–C6和交付不足为N；H1/H2/H3/H5通用规则保持。任务上限30分钟、50次实际生成请求，Axi复核计入总预算。
