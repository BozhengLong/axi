import type { ContentBlock, ModelResponse } from "../src/api/types.ts";

export const encoder = new TextEncoder();
export function event(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}  \n\n`;
}

// 这些事件只构造服务端消息，不调用客户端的解析和拼装代码。
export function streamFixture(blocks: ContentBlock[] = [{ type: "text", text: "完成" }], stop = "end_turn"): string {
  let wire = event("message_start", { message: { role: "assistant", content: [], usage: { input_tokens: 17, output_tokens: 1, cache_read_input_tokens: 4 } } });
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      wire += event("content_block_start", { index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      for (let i = 0; i < json.length; i += 7) wire += event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 7) } });
    } else if (block.type === "thinking") {
      wire += event("content_block_start", { index, content_block: { ...block, thinking: "", signature: "" } });
      wire += event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      wire += event("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
    } else {
      wire += event("content_block_start", { index, content_block: block });
    }
    wire += event("content_block_stop", { index });
  });
  wire += event("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 8 } });
  return wire + event("message_stop");
}

export function response(blocks: ContentBlock[], stopReason = "end_turn"): ModelResponse {
  return { content: blocks, stopReason, usage: { input_tokens: 17, output_tokens: 8 } };
}
export const textResponse = () => response([{ type: "text", text: "完成" }]);
export const tool = (id: string, command: string): ContentBlock => ({ type: "tool_use", id, name: "bash", input: { command } });
export const activeSignal = () => new AbortController().signal;
