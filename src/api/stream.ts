import { isObject, type ContentBlock, type JsonObject, type ModelResponse, type StreamCallbacks } from "./types.ts";
import type { SSEEvent } from "./sse.ts";

export class ProtocolError extends Error {}
export class StreamAPIError extends Error {
  constructor(public errorType: string, message: string) { super(message); }
}

interface BlockState { block: ContentBlock; json: string; hasJson: boolean; closed: boolean }

export class MessageAssembler {
  private started = false;
  private stopped = false;
  private stopReason: string | null = null;
  private blocks: BlockState[] = [];
  private usage: Record<string, number> = {};

  constructor(private callbacks: StreamCallbacks = {}) {}

  get complete(): boolean { return this.stopped; }

  accept(event: SSEEvent): void {
    let value: unknown;
    try { value = JSON.parse(event.data); }
    catch { throw new ProtocolError("SSE data 不是有效 JSON"); }
    if (!isObject(value) || typeof value.type !== "string") throw new ProtocolError("事件缺少 type");
    const type = value.type;
    if (type === "ping") return;
    if (type === "error") {
      const error = isObject(value.error) ? value.error : {};
      throw new StreamAPIError(String(error.type ?? "unknown_error"), String(error.message ?? "流式 API 错误"));
    }
    // 新增的顶层事件可以忽略。已知消息事件必须满足顺序约束。
    if (!["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(type)) return;
    if (this.stopped) throw new ProtocolError("message_stop 后仍收到消息事件");
    if (type === "message_start") {
      if (this.started || !isObject(value.message)) throw new ProtocolError("message_start 无效或重复");
      if (!Array.isArray(value.message.content) || value.message.content.length !== 0) throw new ProtocolError("message_start 必须包含空 content");
      this.started = true;
      this.mergeUsage(value.message.usage);
      return;
    }
    if (!this.started) throw new ProtocolError("未收到 message_start");
    if (type === "content_block_start") {
      if (value.index !== this.blocks.length || !isObject(value.content_block) || typeof value.content_block.type !== "string") {
        throw new ProtocolError("content block 序号或内容无效");
      }
      const block = structuredClone(value.content_block) as ContentBlock;
      this.blocks.push({ block, json: "", hasJson: false, closed: false });
      if (block.type === "text" && typeof block.text === "string") this.callbacks.onText?.(block.text);
      if (block.type === "thinking" && typeof block.thinking === "string") this.callbacks.onThinking?.(block.thinking);
      return;
    }
    if (type === "content_block_delta" || type === "content_block_stop") {
      const state = typeof value.index === "number" && Number.isInteger(value.index) ? this.blocks[value.index] : undefined;
      if (!state || state.closed) throw new ProtocolError("content block 不存在或已结束");
      if (type === "content_block_stop") {
        if (state.block.type === "tool_use") {
          if (state.hasJson) {
            try { state.block.input = JSON.parse(state.json); }
            catch { throw new ProtocolError("工具参数不是完整 JSON；本次响应未写入历史，工具未执行"); }
          }
          if (!isObject(state.block.input) || typeof state.block.id !== "string" || !state.block.id || typeof state.block.name !== "string") {
            throw new ProtocolError("工具调用必须包含 id、name 和 JSON 对象参数");
          }
        }
        state.closed = true;
        return;
      }
      if (!isObject(value.delta)) throw new ProtocolError("缺少 content delta");
      const delta = value.delta;
      switch (delta.type) {
        case "text_delta":
          this.append(state.block, "text", "text", delta.text);
          this.callbacks.onText?.(delta.text as string);
          break;
        case "thinking_delta":
          this.append(state.block, "thinking", "thinking", delta.thinking);
          this.callbacks.onThinking?.(delta.thinking as string);
          break;
        case "signature_delta": this.append(state.block, "thinking", "signature", delta.signature); break;
        case "input_json_delta":
          if (state.block.type !== "tool_use" || typeof delta.partial_json !== "string") throw new ProtocolError("工具参数 delta 无效");
          state.hasJson = true;
          state.json += delta.partial_json;
          break;
        default: throw new ProtocolError(`不支持 content delta：${String(delta.type)}；响应未写入历史`);
      }
      return;
    }
    if (type === "message_delta") {
      if (!isObject(value.delta)) throw new ProtocolError("缺少 message delta");
      if (typeof value.delta.stop_reason === "string") this.stopReason = value.delta.stop_reason;
      this.mergeUsage(value.usage);
      return;
    }
    if (!this.stopReason || this.blocks.some(state => !state.closed)) throw new ProtocolError("message_stop 前仍有未完成内容");
    const ids = this.blocks.filter(state => state.block.type === "tool_use").map(state => state.block.id);
    if (new Set(ids).size !== ids.length) throw new ProtocolError("工具调用 id 重复");
    this.stopped = true;
  }

  finish(): ModelResponse {
    if (!this.stopped) throw new StreamAPIError("connection_error", "响应中断：未收到 message_stop");
    return { content: this.blocks.map(state => state.block), stopReason: this.stopReason!, usage: this.usage };
  }

  private append(block: ContentBlock, type: string, key: string, value: unknown): void {
    if (block.type !== type || typeof value !== "string" || (block[key] !== undefined && typeof block[key] !== "string")) {
      throw new ProtocolError(`${key} delta 与内容块不匹配`);
    }
    block[key] = (block[key] as string | undefined ?? "") + value;
  }

  private mergeUsage(value: unknown): void {
    if (!isObject(value)) return;
    // message_delta 的 usage 是累计值，不能逐事件相加。
    for (const [key, count] of Object.entries(value)) if (typeof count === "number") this.usage[key] = count;
  }
}
