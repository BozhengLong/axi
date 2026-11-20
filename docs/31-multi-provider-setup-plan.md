# Axi 多提供商接入与首次配置方案

2026-11-20。D1–D5 已确认。用户随后决定暂缓 Ollama。D2、D4 和 D5 已按此决定更新。原方案计划 14 次，调整后计划 12 次。首轮候选的结果按原范围留存。[原验收记录](verification/2026-11-20-v002-provider-installer.md) · [范围调整记录](devlog/2026-11-20.md#暂缓-ollama-首批支持)

`v0.0.1` 从两个环境变量读取网关和 Key，并固定使用 Anthropic Messages 与 `claude-opus-5-5`。该版本已用兼容网关做真实任务。下文列出首批验证目标。Axi 延用 Bun、直接 HTTP 和自有任务循环。[发布版配置](https://github.com/BozhengLong/axi/blob/edaaa63738400012d11338db432dd16ce1278c11/src/config.ts) · [预览验证](verification/2026-11-20-preview-v001-and-v28-scoring.md)

| 决策 | 建议 |
|---|---|
| D1 首次配置 | 提供 `axi setup`。选择提供商、模型和认证。选好的连接配置可命名，后续可用 `axi --profile NAME` 启动。 |
| D2 首批范围 | 验证 Claude 官方 API、OpenAI 官方 API、DeepSeek、OpenRouter、百炼 Coding Plan（中国内地）。原 Anthropic 兼容网关单独走兼容复验。 |
| D3 接入边界 | 实现 Messages、Responses 和 Chat Completions 三个协议适配器。认证和能力按预设登记。密钥由系统凭据库、指定环境变量或本次输入提供。 |
| D4 真实验收 | 每个冻结连接跑相同的两道实际代码任务。独立检查最终产物、工具配对、审批行为与 Trace。 |
| D5 安装器衔接 | 安装器安装同一冻结二进制。用户运行 `axi setup` 时配置模型。公开制品分别通过安装验收与提供商验收。 |

## D1 用户如何配置

1. 用户可在任意目录运行 `axi setup`。安装后首次运行 `axi` 时，如没有可用配置，显示该命令。设置入口和 `axi --help`、`axi --version` 在打开项目、创建会话 Trace 或加载模型前分流。
2. 用户选择提供商。官方预设填入协议和地址。自定义入口要求选协议和填写地址。用户从初始模型建议选择，或输入自己的模型 ID。确认界面显示实际应用的提供商、模型与地址。
3. 用户选择认证。云端可遮掩输入 Key 并存入系统凭据库，也可指定环境变量。如果凭据库不可用，支持环境变量或每次启动时遮掩输入。本机自定义端点可以使用免密模式。设置不会自动订阅费用或下载模型。
4. 用户可显式选择连通性测试。开始前显示目标和可能产生用量。测试只发送一条短文本，无项目文件、历史消息和工具。结果显示连接、认证或模型错误。连接成功只表示文本请求通过。跳过测试可保存为待验证。失败或取消保留此前可用配置。
5. 用户确认配置名和默认项，再保存。默认配置用于普通的 `axi`。显式 `--profile NAME` 只解析该配置。配置缺失或错误时显示原因。重开会话后才可换提供商和模型。

配置建议放在 `$XDG_CONFIG_HOME/axi/config.json`，缺省为 `~/.config/axi/config.json`。只保存协议、模型、地址和密钥引用。例如：

```json
{
  "schema": 1,
  "defaultProfile": "deepseek-work",
  "profiles": {
    "deepseek-work": {
      "provider": "deepseek",
      "protocol": "chat-completions",
      "model": "deepseek-flash",
      "auth": { "type": "env", "name": "DEEPSEEK_API_KEY" }
    }
  }
}
```

用户可通过 `axi setup --profile deepseek-work` 编辑此配置。无用户配置时，原 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` 和默认模型继续可用。原 `AXI_RETRY_WINDOW_MS` 继续控制故障恢复窗口。显式配置一旦选定，只使用其账户和地址。流式错误、凭据无效或模型缺失时提示修正。配置文件权限为 `0600`。更新时先准备新的凭据引用，再原子替换配置。失败或并发冲突时保留原配置及其凭据。

## D2 首批接入和验证型号

表内是要实测并记录的具体组合。用户可在设置中配置同协议的其他模型。公开支持表只登记验证过的组合。

| 入口 | 协议 | 首批验证模型 | 认证和范围 |
|---|---|---|---|
| Claude 官方 API | Anthropic Messages | `claude-opus-5-5` | Claude Console API Key。使用官方地址 `https://api.anthropic.com`。[官方型号](https://platform.claude.com/docs/en/models/opus-5-5/overview) |
| OpenAI 官方 API | OpenAI Responses | `gpt-5.4-mini` | OpenAI Platform API Key。使用官方地址 `https://api.openai.com/v1`。[官方型号](https://developers.openai.com/api/docs/models/gpt-5.4-mini) |
| DeepSeek 官方 API | OpenAI Chat Completions | `deepseek-flash` | DeepSeek API Key。使用官方地址 `https://api.deepseek.com`。[官方接口](https://api-docs.deepseek.com/api/create-chat-completion/) |
| OpenRouter | OpenAI Chat Completions | `openai/gpt-5.4-mini` | OpenRouter API Key。验收固定上游路由，关掉该轮路由回退并记录返回的提供商。[型号](https://openrouter.ai/openai/gpt-5.4-mini) · [路由规则](https://openrouter.ai/docs/guides/routing/provider-selection) |
| 阿里云百炼 Coding Plan（中国内地） | OpenAI Chat Completions | `qwen3.7-plus` | 用户自己的套餐 Key。使用 `https://coding.dashscope.aliyuncs.com/v1`，核对套餐用量。套餐 Key 与普通百炼 Key 分开。[套餐文档](https://help.aliyun.com/zh/model-studio/coding-plan) |

原 Anthropic 兼容网关用旧环境变量和 `claude-opus-5-5` 复验。新自定义预设允许用户明确指定协议、地址和模型，其兼容性以实际能力为准。

订阅用户优先使用其计划官方提供的 API Key。首批以百炼的一种已核对套餐为例。Kimi Code、MiniMax、Gemini、企业云凭据和本地模型待单独验证。Claude.ai 或 ChatGPT 的订阅登录作为独立设计。Claude 第三方接入遵照其 API 认证政策，ChatGPT 的 Codex 登录是官方客户端渠道。[Anthropic 认证政策](https://code.claude.com/docs/en/legal-and-compliance) · [Codex 认证](https://learn.chatgpt.com/docs/auth)

## D3 协议和凭据

- 三个协议适配器分别生成请求和解析服务端发送事件（SSE）。Axi 的任务循环继续控制文件、工具调用匹配、权限确认、复核和 Trace。仅在收到完整且可归属的工具调用后执行。流中断时，保留此前完成的修改，失败响应不追加到对话。
- 保留当前 Anthropic 的原生消息及签名。OpenAI Responses 采用 `store: false` 并按文档回传工具结果和所需的推理项。DeepSeek 思考模式在使用工具时需要回传前文的 `reasoning_content`。每个预设只发其支持的字段。按协议和预设地址拼接请求路径。例如 DeepSeek 的官方 Chat Completions 路径为 `/chat/completions`。适配器分别验证结束状态、工具标识和续轮序列。[OpenAI 会话状态](https://developers.openai.com/api/docs/guides/conversation-state) · [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- 每次会话绑定一个配置。临时故障沿用有界等待和原尝试留证。普通密钥失效提示重新配置。现有 OAuth 过期特例只留在原受支持的接入，其他凭据错误按已验证的协议语义处理。切换账户或协议通过显式重开会话。
- 默认凭据库使用 `Bun.secrets`。本机 Bun 1.3.14 可识别其读写 API。macOS 使用钥匙串，Linux 需有可用的 Secret Service 守护进程。独立制品须实测。命名配置文件写密钥引用，环境变量与会话输入可作无凭据库环境的备选。[Bun 凭据库文档](https://bun.com/docs/runtime/secrets)
- Key 的值从授权来源读入，仅发给选定端点。正式预设使用明确的 HTTPS 地址，免密配置只使用本机回环地址。跨源重定向停止，不转发认证头。Key 不写进命令行参数、项目文件、Trace 或公开附件。工具子进程的环境排除 Axi 消费的已知 Key 变量。环境变量备选保留用户已有的自动化和兼容网关入口。

## D4 如何用真实任务验收

**固定输入。** 使用公开 `v0.0.1` 源码建立两个临时 Git 工作副本。每次以相同干净基线开始，加入一份已登记的用户未提交说明。独立评分脚本读取工作树结果。实际请求使用候选 Axi 和该行真实服务。这是接入验证，与 R7 和正式 20 道代表题独立。

| 任务 | 要求 | 独立验收 |
|---|---|---|
| P1 配置回归 | 让旧版 `src/config.ts` 读取可选 `AXI_MODEL`。明确值须去掉外侧空白，显式空值须报错，缺省模型和原地址验证须保持。新增回归检查。 | 对比允许改动的文件。独立运行覆盖新旧路径的测试。确认 Axi 读取原代码、发起工具调用、回传结果并继续对话。 |
| P2 离线版本入口 | 为实际 CLI 启动代码补 `--version`，使用夹具规定的 `0.0.1`。先请求创建独立草稿文件。在拒绝后转入已允许的版本入口修改。 | 在禁止网络且无模型凭据时运行 `--version`。核对实际输出和 `--help`。检查一次明确拒绝后的草稿仍不存在，通过审批的改动才落盘，用户说明、HEAD 和索引保持原值。 |

**执行与通过线。**

1. 冻结 Axi 源码提交、构建件、协议版本、模型 ID、端点、账户类型、试用者批准的请求范围及任务输入哈希。五个云端预设各跑 P1、P2。原网关也跑两题。计划共 12 次真实任务。单题外部观察上限为 15 分钟；这是验证运行器的观察窗口。
2. 每行须完成两题。每题必须观察到实际流式响应、有效工具调用、工具结果回传及后续响应。独立判分验证功能、批准或拒绝、工作区保护及日志。失败的首次证据保留。缺乏凭据、额度或可用模型时明确登记阻塞。
3. 用本地模拟补齐故障路径。覆盖 401、429、断流、缺工具 ID、乱序和拒绝后的重入。使用人工生成的测试 Key 验证终端、工具子进程、Trace 及下载件的密钥排除。复验默认配置、环境变量兼容回退、无凭据库和取消设置。平台可复现操作记录与完整 Trace 保存在本机；公开矩阵只报告适用范围、状态和脱敏结果。

## D5 与 v0.0.2 安装器的衔接

- 安装器和提供商适配可独立开发。候选从已发布的产品源码起步。公开交付件使用同一冻结提交、编译版本和哈希，不从旧评分分支的运行源码拼装。安装脚本只负责平台识别、下载、验证和安装。使用者运行 `axi setup` 后才配置模型。
- 按方案 29 在每个拟公布的操作系统与架构实测安装、离线 `--version`、`--help` 和设置入口。使用安装后的实际文件运行一次 P2，并验证配置可保存、重启可复用。相同平台和同一交付件如果已完成 D4 的 P2，可使用该份证据。至少演练一次升级、失败回退及保留配置后的恢复。旧版使用时仍可按原环境变量启动。
- 公开 `v0.0.2` 的支持表逐行列出经过验收的协议、模型和平台。只有通过 D4 的连接才列为已验证。只有通过方案 29 的平台才给安装入口。macOS 签名、公证和真实下载验证仍按方案 29。首批目标是五个云端预设和原网关都通过。出现长期缺项时，在公开发布确认中明确拟交付的已验证子集和未验证项。正式 v1 继续走原验收。[安装器方案](29-official-installer-preview-plan.md) · [正式发布契约](15-v1-release-contract-v2.md)
- 英文 Quickstart 用“安装 → `axi setup` → 在临时项目开始首题”的顺序。文档并列给出套餐地址规则和现有脚本的环境变量方式。旧版 `v0.0.1` 继续使用自己的指南。
