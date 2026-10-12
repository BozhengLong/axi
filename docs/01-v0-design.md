# v0 设计：最小 agent 循环

> 状态：**待拍板**（见文末决策点 D1–D5）

## 目标

在终端里运行 `bun run axi`，进入多轮对话。模型可以调用 `bash` 工具，**每条命令执行前都要你按 y 确认**。

验收任务：

1. "这个目录里有什么，总共多大？"（单次工具调用）
2. "写一个 hello.py 并运行它"（多次工具调用、多轮循环）
3. 拒绝一条命令，看模型能不能换个办法继续（错误恢复）

## 整体结构

```
src/
  main.ts            入口：REPL，读用户输入、渲染输出
  api/
    sse.ts           字节流 → SSE 事件（纯函数，可单测）
    stream.ts        SSE 事件 → 拼装好的 assistant 消息
    client.ts        发 HTTP 请求、重试、错误分类
  agent/
    loop.ts          agent 主循环
  tools/
    bash.ts          bash 工具：schema + 执行 + 截断
  ui/
    permission.ts    命令确认
  log.ts             原始请求/响应写入 .axi/logs/
```

数据流：

```
用户输入 → loop → client.fetch(stream:true)
                     ↓ ReadableStream<Uint8Array>
                  sse.ts（切事件）
                     ↓ {event, data}
                  stream.ts（拼 content block，同时回调 UI 实时显示）
                     ↓ 完整 assistant 消息
          loop：stop_reason == tool_use ? → 确认 → 执行 → tool_result → 再请求
                                        : → 回到用户输入
```

## 一、协议层：手写 SSE 解析

### 已经实测到的事实（2026-10-12，经公司网关）

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""} }

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}              }
...
event: message_delta        ← stop_reason 和最终 usage 在这里
event: message_stop
```

注意 `data` 末尾有**一串空格填充**，还会穿插 `ping` 事件。解析器必须容忍这两点。

### 解析器要处理的坑

| 坑 | 处理 |
|---|---|
| 网络分片是任意切的：一个事件可能分在两个 chunk 里，一个 chunk 也可能包含好几个事件 | 用缓冲区攒字节，遇到空行（`\n\n`）才算一个事件结束 |
| 一个中文字符（3 字节）可能被切成两半 | `TextDecoder` 开 `{stream: true}` |
| `ping` | 直接忽略 |
| `event: error`（如 `overloaded_error`），HTTP 状态码却是 200 | 当作可重试错误抛出 |
| 流中途断开（没收到 `message_stop`） | 视为失败，**不把半截消息写进历史** |

### 拼装 content block

按 `index` 维护数组，按 delta 类型处理：

| delta 类型 | 处理 |
|---|---|
| `text_delta` | 追加文本，同时实时打印 |
| `thinking_delta` | 追加思考文本（显示方式见 D2） |
| `signature_delta` | 思考块的签名，**原样保存** |
| `input_json_delta` | 追加 `partial_json` 字符串，到 `content_block_stop` 时才 `JSON.parse` |

`input_json_delta` 是个学习点：工具参数是一截一截流过来的 JSON 碎片，中途不能解析。解析失败（比如被 `max_tokens` 截断）时，要回给模型一个 `is_error: true` 的 tool_result，不能执行半截命令。

### thinking 块必须原样回传

`claude-opus-5-5` 的 thinking 无法关闭。它返回的 `thinking` 块（含 `signature`）**必须原封不动地放回历史**，下一轮请求要带上。

这意味着从 v0 起就定一条铁律：**历史只追加，不修改**（append-only）。v2 做上下文压缩时，这条约束会显著影响设计。

## 二、Agent 循环

```ts
while (true) {
  const msg = await callModel(history)      // 流式
  history.push({ role: "assistant", content: msg.content })  // 整块追加，含 thinking

  switch (msg.stop_reason) {
    case "end_turn":   return               // 回到用户输入
    case "tool_use":   break                // 执行工具，继续循环
    case "max_tokens": 提示用户；如果最后一块是 tool_use，回 is_error 让模型重来
    case "refusal":    提示用户，结束本轮
  }

  const results = await runTools(msg.tool_uses)  // 可能有多个（并行调用）
  history.push({ role: "user", content: results })  // 所有结果放进同一条 user 消息
}
```

两个容易写错的地方：

- **并行工具调用**：一条 assistant 消息里可能有多个 `tool_use`，所有 `tool_result` 必须放在**同一条** user 消息里返回。拆成多条消息会让模型以后不再并行调用。
- **每个 tool_use 都必须有对应的 tool_result**，被拒绝或报错也一样（用 `is_error: true`），否则下一次请求直接 400。

循环上限：单轮用户输入最多 50 次模型调用，防止死循环。

## 三、bash 工具

```jsonc
{
  "name": "bash",
  "description": "在用户的 macOS 终端执行一条 shell 命令……",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": { "type": "string" },
      "timeout_ms": { "type": "number" }
    },
    "required": ["command"]
  }
}
```

执行方式：

- 每次调用都 `Bun.spawn(["bash", "-c", command], { cwd })`。**无状态**：上一条命令里的 `cd`、`export` 不会带到下一条。v1 再考虑持久 shell。
- stdout 和 stderr 合并，结果里附上退出码。
- 默认超时 120 秒，超时就杀掉进程，并告诉模型"超时了"。
- **输出截断**：超过 30,000 字符时保留头尾各一半，中间写 `[省略 N 字符]`。不截断的话，一条 `cat` 大文件的命令就能撑爆上下文。

### 安全

- 执行前展示命令，等你确认。
- 坦白说：v0 **无法**真正把模型限制在项目目录里。`cd /` 或绝对路径都能逃出去。v0 唯一的防线是"每条都确认"。真正的隔离（macOS `sandbox-exec`）放到 v4。

## 四、请求参数

| 参数 | 值 | 说明 |
|---|---|---|
| `model` | `claude-opus-5-5` | |
| `max_tokens` | 64000 | 流式请求不怕超时，给足空间 |
| `stream` | `true` | |
| `output_config.effort` | 见 D4 | |
| `thinking` | `{type: "adaptive", display: ...}` | 见 D2 |
| 工具上的 `eager_input_streaming` | `true` | 参数一生成就流过来，不等服务端缓冲完。代价是服务端不再校验 JSON，客户端要自己校验 |
| system prompt | 简短：身份、工作目录、操作系统 | **不放当前时间**，否则每次请求前缀都变，v2 做缓存时会失效 |

## 五、可观测性（v0 就做）

- 每次模型调用结束打印一行：`↑ 输入 1,234（缓存读 0 / 写 0） ↓ 输出 567  ⏱ 3.2s`
- 每个请求体和每条原始 SSE 行都写入 `.axi/logs/<session>.jsonl`，后面做实验和排查问题都靠它。

## 六、错误处理

| 情况 | 处理 |
|---|---|
| 429 / 500 / 529 / 网络错误 / 流中 `error` 事件 | 指数退避重试 3 次（1s、2s、4s），有 `retry-after` 头就按它来 |
| 400 / 401 / 404 | 不重试，打印错误体。400 多半是我们的历史拼错了，这时正好看日志 |
| Ctrl+C | v0：中止当前请求，丢弃这轮未完成的 assistant 消息，回到输入框（见 D5） |

## 七、v0 不做的事

文件读写工具、edit、权限规则、持久 shell、会话保存、prompt caching、上下文压缩、TUI、subagent、MCP。

## 八、配套实验

| # | 实验 | 想看到什么 |
|---|---|---|
| E1 | `AXI_DEBUG=sse` 打印带时间戳的原始 SSE 行 | 真实的分片长什么样、`ping` 多久来一次、首 token 延迟 |
| E2 | 让模型写一个长文件（`cat <<EOF`），观察 `input_json_delta` | 工具参数是怎么一截截流过来的；开关 `eager_input_streaming` 的区别 |
| E3 | "同时看一下 3 个目录的大小" | 模型会不会在一条消息里并行调用多个工具 |
| E4 | 拒绝一条 `rm` 命令，并附上理由 | 模型拿到 `is_error` 后怎么调整 |
| E5 | 故意不回传 thinking 块 | 观察 API 怎么报错，理解 append-only 为什么重要 |

## 决策点（请拍板）

**D1 交互形式**
- A. REPL 多轮对话（推荐）：更像真实产品，也能测多轮上下文
- B. 一次性命令 `axi "做某事"`：更简单，但学不到多轮

**D2 思考过程怎么显示**
- A. `display: "summarized"`，灰色小字实时显示思考摘要（推荐）：能看到模型为什么这么做，对学习帮助很大
- B. `omitted`（API 默认）：思考时只显示一个转圈，界面干净

**D3 确认粒度**
- A. 每条命令都确认（推荐 v0 用）：最安全，也能让你亲眼看到模型的每一步
- B. 只读命令（`ls`、`cat`、`git status`……）自动放行：体验更好，但"什么算只读"本身就是个难题，留到 v1 专门讨论

**D4 effort 默认档位**
- A. `high`（推荐）：编码类任务受益明显
- B. `medium`（Opus 5.5 的默认值）：更快，花的 token 更少
- 不管选哪个，都加 `/effort` 命令随时切换，方便做对比实验

**D5 拒绝命令时**
- A. 按 n 后可以输入一句理由，作为错误信息回给模型（推荐）：模型能据此调整
- B. 直接回"用户拒绝"
