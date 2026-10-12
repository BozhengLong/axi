import { describe, expect, test } from "bun:test";
import { SSEParser } from "../src/api/sse.ts";
import { MessageAssembler, ProtocolError, StreamAPIError } from "../src/api/stream.ts";
import { encoder, event, streamFixture, tool } from "./fixtures.ts";

describe("SSE 字节边界", () => {
  test("每个字节切分点都能还原中文、CRLF、多行 data 和空格", () => {
    const bytes = encoder.encode("\ufeff: comment\r\nevent: sample\r\ndata: 中文🙂\r\ndata:  尾部  \r\n\r\nevent: empty\rdata:\r\r");
    for (let split = 0; split <= bytes.length; split++) {
      const parser = new SSEParser();
      const events = [...parser.feed(bytes.slice(0, split)), ...parser.feed(bytes.slice(split)), ...parser.finish()];
      expect(events).toEqual([{ event: "sample", data: "中文🙂\n 尾部  " }, { event: "empty", data: "" }]);
    }
  });
  test("逐字节输入；EOF 不派发不完整事件", () => {
    const parser = new SSEParser();
    const events = Array.from(encoder.encode("data: 中文\n\ndata: 不完整\n")).flatMap(byte => parser.feed(new Uint8Array([byte])));
    expect([...events, ...parser.finish()]).toEqual([{ event: "message", data: "中文" }]);
  });
  test("未知字段、只有注释的事件不产生内容", () => {
    const parser = new SSEParser();
    expect(parser.feed(encoder.encode(": ping\nretry: 1\nid: foo\n\ndata: x\n\n"))).toEqual([{ event: "message", data: "x" }]);
  });
});

function assemble(wire: string, assembler = new MessageAssembler()) {
  const parser = new SSEParser();
  for (const byte of encoder.encode(wire)) for (const ev of parser.feed(new Uint8Array([byte]))) assembler.accept(ev);
  for (const ev of parser.finish()) assembler.accept(ev);
  return assembler.finish();
}

describe("消息拼装", () => {
  test("保留思考签名、遮盖块和附加字段；恢复工具 JSON；usage 不重复累加", () => {
    const blocks = [
      { type: "thinking", thinking: "先核对文件。", signature: "sig+/==中文", extra: { keep: true } },
      { type: "redacted_thinking", data: "encrypted" },
      { type: "text", text: "读取目录" },
      tool("a", "printf '你好🙂\\n'"), tool("b", "pwd"),
    ];
    let thinking = "";
    const result = assemble(streamFixture(blocks, "tool_use"), new MessageAssembler({ onThinking: text => thinking += text }));
    expect(result.content).toEqual(blocks);
    expect(thinking).toBe("先核对文件。");
    expect(result.usage).toEqual({ input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 4 });
  });
  test("忽略 ping 和新增顶层事件", () => {
    expect(assemble(event("ping") + event("future_event", { x: 1 }) + streamFixture()).stopReason).toBe("end_turn");
  });
  test("没有 message_stop 的响应不能成功", () => {
    expect(() => assemble(streamFixture().replace(event("message_stop"), ""))).toThrow(StreamAPIError);
  });
  test("工具 JSON 无效时不生成可执行的响应", () => {
    const wire = streamFixture([tool("bad", "pwd")], "tool_use").replace('partial_json":"{\\"comma', 'partial_json":"!\\"comma');
    expect(() => assemble(wire)).toThrow(ProtocolError);
  });
  test("流中错误保留错误类型，便于决定是否重试", () => {
    try { assemble(event("error", { error: { type: "authentication_error", message: "bad key" } })); }
    catch (error) { expect(error).toBeInstanceOf(StreamAPIError); expect((error as StreamAPIError).errorType).toBe("authentication_error"); return; }
    throw new Error("负向用例没有触发错误");
  });
  test("重复 id、错误序号、块未结束和未知 delta 都失败", () => {
    expect(() => assemble(streamFixture([tool("same", "pwd"), tool("same", "ls")], "tool_use"))).toThrow("id 重复");
    expect(() => assemble(streamFixture().replace('"index":0', '"index":3'))).toThrow(ProtocolError);
    expect(() => assemble(streamFixture().replace(event("content_block_stop", { index: 0 }), ""))).toThrow(ProtocolError);
    const unknownDelta = event("content_block_delta", { index: 0, delta: { type: "unknown_delta" } });
    expect(() => assemble(streamFixture().replace(event("content_block_stop", { index: 0 }), unknownDelta))).toThrow(ProtocolError);
  });
});
