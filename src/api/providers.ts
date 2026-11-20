import type { APIConfig } from "../config.ts";
import { toolDefinitions } from "../tools/registry.ts";
import { MessageAssembler, ProtocolError, StreamAPIError } from "./stream.ts";
import type { SSEEvent } from "./sse.ts";
import { isObject, type ContentBlock, type Effort, type JsonObject, type Message, type ModelResponse, type StreamCallbacks, type ToolUse } from "./types.ts";

function blocks(message: Message): ContentBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function responsesInput(history: readonly Message[]): JsonObject[] {
  return history.flatMap(message => {
    const parts = blocks(message);
    const saved = parts.find(part => part.type === "responses_output");
    if (message.role === "assistant" && saved) return saved.items as JsonObject[];
    return parts.flatMap<JsonObject>(part => {
      if (part.type === "text") return [{ role: message.role, content: part.text }];
      if (part.type === "tool_result") return [{ type: "function_call_output", call_id: part.tool_use_id, output: part.content }];
      throw new ProtocolError("无法重放 Responses 会话内容");
    });
  });
}

function chatMessages(system: string, history: readonly Message[], reasoning: boolean): JsonObject[] {
  const messages: JsonObject[] = [{ role: "system", content: system }];
  for (const entry of history) {
    const parts = blocks(entry);
    const text = parts.filter(part => part.type === "text").map(part => part.text).join("");
    if (entry.role === "assistant") {
      const calls = parts.filter(part => part.type === "tool_use").map(part => ({
        id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input) },
      }));
      const saved = parts.find(part => part.type === "chat_reasoning");
      messages.push({ role: "assistant", content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: saved?.text ?? "" } : {}),
      });
      continue;
    }
    if (text) messages.push({ role: "user", content: text });
    for (const result of parts.filter(part => part.type === "tool_result")) {
      messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
    }
  }
  return messages;
}

export function requestBody(config: APIConfig, system: string, history: readonly Message[], effort: Effort, eager: boolean): JsonObject {
  const common = { model: config.model, stream: true };
  if (config.protocol === "openai-responses") return {
    ...common, instructions: system, input: responsesInput(history), store: false,
    include: ["reasoning.encrypted_content"], max_output_tokens: 16384,
    tools: toolDefinitions.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false })),
  };
  if (config.protocol === "chat-completions") return {
    ...common, max_tokens: config.provider === "ollama" ? 4096 : 16384,
    messages: chatMessages(system, history, config.provider === "deepseek"),
    tools: toolDefinitions.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
    ...(config.provider === "openrouter" ? { provider: {
      require_parameters: true, allow_fallbacks: false,
      ...(config.model === "openai/gpt-5.4-mini" ? { only: ["openai"] } : {}),
    } } : {}),
  };
  const adaptive = !config.protocol || config.provider === "anthropic" && config.model === "claude-opus-5-5";
  return {
    ...common, max_tokens: adaptive ? 64000 : 4096, system,
    ...(adaptive ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } } : {}),
    tools: !config.protocol ? toolDefinitions.map(tool => ({ ...tool, eager_input_streaming: eager })) : toolDefinitions,
    messages: history,
  };
}

interface Assembler {
  readonly complete: boolean;
  accept(event: SSEEvent): void;
  finish(): ModelResponse;
}

export function assemblerFor(config: APIConfig, callbacks: StreamCallbacks): Assembler {
  if (config.protocol === "openai-responses") return new ResponsesAssembler(callbacks);
  if (config.protocol === "chat-completions") return new ChatAssembler(callbacks, config.provider === "deepseek");
  return new MessageAssembler(callbacks, config.upstreamOAuth !== false);
}

function parseEvent(event: SSEEvent): JsonObject {
  let value: unknown;
  try { value = JSON.parse(event.data); } catch { throw new ProtocolError("SSE data 不是有效 JSON"); }
  if (!isObject(value)) throw new ProtocolError("SSE data 必须是对象");
  return value;
}

function providerError(data: unknown): never {
  const error = isObject(data) ? data : {};
  const code = String(error.code ?? error.type ?? "provider_error");
  const kind = ["rate_limit_exceeded", "rate_limit_error"].includes(code) ? "rate_limit_error"
    : ["server_error", "internal_server_error", "api_error"].includes(code) ? "api_error" : "provider_error";
  throw new StreamAPIError(kind, typeof error.message === "string" ? error.message : "提供商返回流式错误", undefined, data);
}

function argumentsObject(raw: unknown): JsonObject {
  if (typeof raw !== "string") throw new ProtocolError("缺少工具参数");
  let args: unknown;
  try { args = JSON.parse(raw); } catch { throw new ProtocolError("工具参数不是有效 JSON"); }
  if (!isObject(args)) throw new ProtocolError("工具参数必须是对象");
  return args;
}

function toolCall(id: unknown, name: unknown, raw: unknown): ToolUse {
  if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()) throw new ProtocolError("工具调用缺少标识或名称");
  return { type: "tool_use", id, name, input: argumentsObject(raw) };
}

function uniqueTools(calls: ToolUse[]): ToolUse[] {
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw new ProtocolError("工具调用标识重复");
  return calls;
}

function usage(value: unknown, input: string, output: string): Record<string, number> {
  const result: Record<string, number> = {};
  if (isObject(value)) {
    if (typeof value[input] === "number") result.input_tokens = value[input];
    if (typeof value[output] === "number") result.output_tokens = value[output];
  }
  return result;
}

class ChatAssembler implements Assembler {
  complete = false;
  private text = "";
  private reasoning = "";
  private reason = "";
  private upstreamProvider?: string;
  private counts: Record<string, number> = {};
  private calls = new Map<number, { id: string; name: string; raw: string }>();

  constructor(private callbacks: StreamCallbacks, private replayReasoning: boolean) {}

  accept(event: SSEEvent): void {
    if (this.complete) throw new ProtocolError("Chat 流在终止后仍返回事件");
    if (event.data === "[DONE]") {
      if (!this.reason) throw new ProtocolError("Chat 流缺少 finish_reason");
      this.complete = true;
      return;
    }
    const data = parseEvent(event);
    if (data.error || event.event === "error") providerError(data.error ?? data);
    if (typeof data.provider === "string" && data.provider.trim()) {
      if (this.upstreamProvider && this.upstreamProvider !== data.provider) throw new ProtocolError("Chat 流上游提供商发生变化");
      this.upstreamProvider = data.provider;
    }
    Object.assign(this.counts, usage(data.usage, "prompt_tokens", "completion_tokens"));
    if (!Array.isArray(data.choices)) throw new ProtocolError("Chat 事件缺少 choices");
    if (data.choices.length === 0) return;
    const choice = data.choices[0];
    if (this.reason || data.choices.length !== 1 || !isObject(choice) || choice.index !== 0 || !isObject(choice.delta)) {
      throw new ProtocolError("Chat choice 结构或顺序无效");
    }
    const delta = choice.delta;
    if (typeof delta.content === "string") {
      this.text += delta.content;
      this.callbacks.onText?.(delta.content);
    }
    if (typeof delta.reasoning_content === "string") {
      this.reasoning += delta.reasoning_content;
      this.callbacks.onThinking?.(delta.reasoning_content);
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new ProtocolError("Chat 工具调用块无效");
      for (const item of delta.tool_calls) {
        if (!isObject(item) || typeof item.index !== "number" || !Number.isSafeInteger(item.index) || item.index < 0 ||
            (item.type !== undefined && item.type !== "function")) throw new ProtocolError("Chat 工具调用索引或类型无效");
        const slot = this.calls.get(item.index) ?? { id: "", name: "", raw: "" };
        if (typeof item.id === "string") slot.id += item.id;
        if (isObject(item.function)) {
          if (typeof item.function.name === "string") slot.name += item.function.name;
          if (typeof item.function.arguments === "string") slot.raw += item.function.arguments;
        }
        this.calls.set(item.index, slot);
      }
    }
    if (typeof choice.finish_reason === "string") this.reason = choice.finish_reason;
  }

  finish(): ModelResponse {
    if (!this.complete) throw new StreamAPIError("connection_error", "响应中断：Chat 流缺少 [DONE]");
    const reasons: Record<string, string> = { stop: "end_turn", length: "max_tokens", content_filter: "refusal", tool_calls: "tool_use" };
    const stopReason = reasons[this.reason];
    if (!stopReason || !Object.hasOwn(reasons, this.reason)) throw new ProtocolError("Chat finish_reason 不受支持");
    const content: ContentBlock[] = [];
    if (this.replayReasoning && this.reasoning) content.push({ type: "chat_reasoning", text: this.reasoning });
    if (this.text) content.push({ type: "text", text: this.text });
    if (stopReason === "tool_use") {
      const ordered = [...this.calls].sort(([a], [b]) => a - b);
      if (!ordered.length || ordered.some(([index], order) => index !== order)) throw new ProtocolError("Chat 工具调用缺失");
      content.push(...uniqueTools(ordered.map(([, slot]) => toolCall(slot.id, slot.name, slot.raw))));
    } else if (stopReason === "end_turn" && this.calls.size) throw new ProtocolError("Chat 工具调用未正常结束");
    return { content, stopReason, usage: this.counts, ...(this.upstreamProvider ? { upstreamProvider: this.upstreamProvider } : {}) };
  }
}

type ResponseSlot = { identity: JsonObject; args: string; sawDelta: boolean; done?: JsonObject };
class ResponsesAssembler implements Assembler {
  complete = false;
  private id?: string;
  private result?: ModelResponse;
  private slots = new Map<number, ResponseSlot>();

  constructor(private callbacks: StreamCallbacks) {}

  accept(event: SSEEvent): void {
    if (this.complete) throw new ProtocolError("Responses 流在终止后仍返回事件");
    const data = parseEvent(event);
    const type = data.type;
    if (type === "error" || event.event === "error") providerError(data.error ?? data);
    if (type === "response.failed") providerError(isObject(data.response) ? data.response.error : data);
    if (type === "response.created") {
      if (this.id || !isObject(data.response) || typeof data.response.id !== "string") throw new ProtocolError("Responses 流缺少唯一响应标识");
      this.id = data.response.id;
      return;
    }
    if (!this.id) throw new ProtocolError("Responses 流未开始");
    if (type === "response.output_text.delta" && typeof data.delta === "string") this.callbacks.onText?.(data.delta);
    if (type === "response.reasoning_summary_text.delta" && typeof data.delta === "string") this.callbacks.onThinking?.(data.delta);
    if (type === "response.incomplete") {
      if (!isObject(data.response) || data.response.id !== this.id) throw new ProtocolError("Responses 终态标识不匹配");
      throw new ProtocolError("Responses 返回未完成状态");
    }
    if (type === "response.completed") { this.commit(data.response); return; }
    if (type === "response.output_item.added" || type === "response.output_item.done" ||
        type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") this.item(data);
  }

  private item(data: JsonObject): void {
    const index = data.output_index;
    const item = data.item;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new ProtocolError("Responses 输出索引无效");
    if (data.type === "response.output_item.added") {
      if (!isObject(item) || typeof item.id !== "string" || this.slots.has(index)) throw new ProtocolError("Responses 输出块无效或重复");
      this.slots.set(index, { identity: item, args: "", sawDelta: false });
      return;
    }
    const slot = this.slots.get(index);
    if (!slot || slot.done) throw new ProtocolError("Responses 输出块的事件顺序无效");
    if (data.type === "response.output_item.done") {
      if (!isObject(item) || item.id !== slot.identity.id || item.type !== slot.identity.type ||
          (item.type === "function_call" && (item.call_id !== slot.identity.call_id || item.name !== slot.identity.name ||
            (slot.sawDelta && item.arguments !== slot.args)))) {
        throw new ProtocolError("Responses 输出块完整性校验失败");
      }
      slot.done = item;
      return;
    }
    if (slot.identity.type !== "function_call" || data.item_id !== slot.identity.id) throw new ProtocolError("Responses 工具参数与输出块不匹配");
    if (data.type === "response.function_call_arguments.delta") {
      if (typeof data.delta !== "string") throw new ProtocolError("Responses 工具参数增量无效");
      slot.args += data.delta;
      slot.sawDelta = true;
    } else if (typeof data.arguments !== "string" || (slot.sawDelta && data.arguments !== slot.args)) {
      throw new ProtocolError("Responses 工具参数终态不一致");
    }
  }

  private commit(value: unknown): void {
    if (!isObject(value) || value.id !== this.id || value.status !== "completed" || !Array.isArray(value.output) ||
        value.output.length !== this.slots.size) throw new ProtocolError("Responses 缺少完整终态");
    const parts: ContentBlock[] = [{ type: "responses_output", items: value.output }];
    const calls: ToolUse[] = [];
    let refused = false;
    for (const [index, item] of value.output.entries()) {
      const done = this.slots.get(index)?.done;
      if (!isObject(item) || !done || item.id !== done.id || item.type !== done.type) throw new ProtocolError("Responses 终态输出块不匹配");
      if (item.type === "function_call") {
        if (item.status !== "completed" || item.call_id !== done.call_id || item.name !== done.name || item.arguments !== done.arguments) {
          throw new ProtocolError("Responses 工具调用终态不匹配");
        }
        calls.push(toolCall(item.call_id, item.name, item.arguments));
      } else if (item.type === "message" && item.role === "assistant" && item.status === "completed" && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (isObject(content) && content.type === "output_text" && typeof content.text === "string") parts.push({ type: "text", text: content.text });
          else if (isObject(content) && content.type === "refusal" && typeof content.refusal === "string") {
            refused = true;
            this.callbacks.onText?.(content.refusal);
            parts.push({ type: "text", text: content.refusal });
          } else throw new ProtocolError("Responses 文本块不受支持");
        }
      } else if (item.type !== "reasoning") throw new ProtocolError("Responses 输出块不受支持");
    }
    if (refused && calls.length) throw new ProtocolError("Responses 同时返回拒绝和工具调用");
    parts.push(...uniqueTools(calls));
    this.result = { content: parts, stopReason: calls.length ? "tool_use" : refused ? "refusal" : "end_turn",
      usage: usage(value.usage, "input_tokens", "output_tokens") };
    this.complete = true;
  }

  finish(): ModelResponse {
    if (!this.result) throw new StreamAPIError("connection_error", "响应中断：未收到 response.completed");
    return this.result;
  }
}
