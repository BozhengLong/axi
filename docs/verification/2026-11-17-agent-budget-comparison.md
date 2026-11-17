# Agent任务预算与重试口径核对

2026-11-17。状态：只读研究。用户问Claude Code、Pi、DeepSeek Harness、Codex是否也有Axi的40次工作请求上限，并授权按需把官方仓库克隆到`~/GitHub`。本记录不修改C2，不恢复已关闭批次，不启动模型任务。

## 比较口径

必须区分四种限制：一项任务内的模型工作步骤、一个失败请求的重试次数、长期目标自动续跑轮次、账户/网关的用量和并发。不同产品把turn、step、round用于不同层，不能只比较字段中的数字。

| 产品/范围 | 核对到的限制 | 能否等同于Axi的40次HTTP尝试 |
|---|---|---|
| Claude Code | 官方CLI文档的`--max-turns`只用于print模式，默认不限制agentic turns；可另设`--max-budget-usd`。这不表示订阅/服务端没有限制。 | 不能。可配置的工作轮数与包含429重试的原始HTTP计数不同。 |
| Pi | 核心循环按工具调用、排队消息、模型结束/错误和取消推进，没有固定40/50轮计数。宿主/扩展可加停止条件。会话层重试在成功响应后重置，不跨正常步骤累加。 | 所查核心实现没有这种固定总次数限制。 |
| DeepSeek Harness | 默认agent-loop按step循环，结束或取消/错误时停止，没有统一40/50次HTTP总量字段。Goal外层自动续跑有可配置轮数上限，默认256；Ralph也有独立的256轮默认上限。 | 不能。Goal/Ralph的轮次属于外层策略，每轮可包含多个模型步骤。 |
| Codex | 本机CLI及官方配置未发现默认40/50次任务总请求上限。官方配置分别列出HTTP重试默认4次、SSE中断重试默认5次；rollout Token预算功能默认关闭，Goal Token上限不配置时不设该限额。最新源码还有可选rollout用量预算，按Token加权或提供方usage单位计量，Goals另有预算和停止状态。 | 未查到Axi这种默认规则；不能把单请求重试或Goal预算当作任务总调用数。 |

“未查到”描述本次源码/公开接口的范围，不承诺商业服务、插件、宿主策略或未来版本没有其他限制。没有运行极限压力测试来推断隐藏后台上限。

## 原始来源与源码入口

1. [Claude Code官方CLI参考](https://code.claude.com/docs/en/cli-reference)：`--max-turns`默认不限制，print模式适用；`--max-budget-usd`另列。公开仓库[anthropics/claude-code](https://github.com/anthropics/claude-code)可查文档、更新记录和扩展材料，不是完整运行时源码。
2. [Pi核心循环](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)：`runLoop`按工具/消息继续；[会话重试](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)在成功assistant响应后重置`_retryAttempt`，注释明确避免跨LLM调用累积。
3. [DeepSeek默认循环文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md)及[实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts)：`turn()`使用逐步循环；`maxTokens`是单请求输出限制，`maxParallelToolCalls`是并行工具数，都不是整项任务的请求数。
4. [DeepSeek Goal](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal/README.md)和[Ralph](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/tool-ralph/README.md)：256指各自外层策略的轮数。它们不能代替核心单轮的分析。
5. [OpenAI官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：`request_max_retries`和`stream_max_retries`是两种重试控制。[官方Goals说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)说明目标预算与暂停/完成/阻塞边界。本机只读检查`codex exec --help`，没有据此推断未公开的后端实现。

本机当次CLI版本：Claude Code2.1.326、Pi0.84.1、Codex0.166.0。它们与本批评测冻结的Claude Code2.1.322不同；比较查询没有升级CLI，也不回写旧评测版本或成绩。

DeepSeek的[重试插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-retry/README.md)另行管理失败步骤：默认normal模式最多重试5次，回退后重跑同一step。可选择always模式，但这不是默认值，也不取消费用、取消信号或外部服务限制。

## 对Axi的判断与待设计项

事实：C2的`GenerationBudget`给auto模式40次工作请求及10次复核请求，所有实际HTTP尝试，包括429和重试，都计入预算。它是本项目的具体设计，不是四种被查产品共同遵守的行业标准。

同批T01/v1的前五组受限调用均重试恢复，其中一组两次重试、四组各一次。第40个请求再遇429，原生日志安排1秒后重试；下一次发送前`consume()`抛预算异常，未进入剩余10次复核。共有7次429和33次完整响应。源码显示工作额度在成功工具响应后耗尽时可以进入复核，但重试期间抛出的预算异常会走退出路径。这是需要单独验证的衔接边界，尚未运行新回归或认定它违反哪个发布条款。

建议下一版设计分开讨论：日常使用的可配置工作预算；失败请求的重试/等待预算；评测外层的统一执行上限。原始请求总数仍完整统计，保留总时长等兜底。是否修改40+10、何时进入复核、达到上限后怎样交付，需要新的设计决定，当前没有实现或改阈值。

本研究不改变旧批INCOMPLETE结论，也不能证明没有429时T01/v1会成功或失败。

## 本地研究副本

按用户“有必要的话……克隆到`~/GitHub`”授权，新建以下官方仓库的浅克隆，保留当前源码快照；未安装依赖、运行仓库脚本或修改已安装CLI。

| 仓库 | 本机目录 | 固定提交 |
|---|---|---|
| https://github.com/earendil-works/pi | `/Users/spidey0o0zheng/GitHub/pi` | `4afe78de1e51162c01c946dcf080e6a266685a01` |
| https://github.com/deepseek-ai/deepseek-harness | `/Users/spidey0o0zheng/GitHub/deepseek-harness` | `39163dd30f703a79079e2d2446545cff3c453738` |
| https://github.com/anthropics/claude-code | `/Users/spidey0o0zheng/GitHub/claude-code` | `e2c963a886e345ca22d5e882ff8a63e3192529d0` |

Codex原有副本在`/Users/spidey0o0zheng/GitHub/codex`，原HEAD为`2151d3a5b78ca93128496b26333bc30187385a5f`且干净。保留该工作树及main分支；仅fetch远端HEAD，用提交对象作只读核对。已成功获取远端HEAD `59ac39addbbcd3499319c805a916846ca8ac5fef`，与当次`git ls-remote origin HEAD`相同。工作区HEAD保持原值，`git status --porcelain`为空。

### Codex最新提交补查

以`git show 59ac39addbbcd3499319c805a916846ca8ac5fef:<path>`读取新提交，不切换已有工作树。`codex-rs/core/src/session/turn.rs`的核心循环依赖是否仍需模型/工具后续工作、取消、上下文整理及预算策略；所查配置和核心路径未发现默认40/50次任务请求计数。

`codex-rs/core/src/config/mod.rs`将`rollout_budget`定义为可选配置。`codex-rs/core/src/rollout_budget.rs`根据提供方`codex_rollout_budget_units`，或输出Token/未缓存输入Token的加权值计入预算；未配置状态时不做这笔本地用量计数。`session/rollout_budget.rs`允许宿主接管计量并发布停止决定。因此不能将Codex描述为“完全没有人为预算”。这些内部路径也不证明每种桌面/云宿主默认采用相同策略。

本次验证只包括官方文档/源码读取、本机版本与help查询、克隆/fetch完成状态、origin/提交和干净工作区检查。未运行这些仓库的功能测试或极限压力测试。三个新副本均是depth=1浅克隆；Codex原副本保持已有历史和工作区。

仓库来源、工作区状态与研究提交的结构化记录见[源码清单](2026-11-17-agent-budget-sources.json)。

## 后续决定与边界核查

2026-11-17后续，读取C2的`tests/review.test.ts`第68–70行，确认旧测试明确要求“第40次请求失败时不借复核额度继续”，并断言40次后停止、未进入复核。所以上文“待验证的衔接边界”已有旧策略测试覆盖，不能直接称为此前未覆盖的代码缺陷。新产品应通过新决策替换该规则。

用户随后明确确认取消任务次数上限、保留连续故障等待上限，已按[设计21/D1–D2](../21-unbounded-task-execution.md)在C2派生的新分支实现并完成本地验证。见[结果](2026-11-17-unbounded-task-development.md)。此决定不改旧评测分数；新产品没有引入隐藏任务总时长或Token上限，外部正式评测边界另行冻结。
