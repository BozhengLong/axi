export type MockReply = { content: any[]; stopReason: string; delayMs?: number; raw?: string; versionFrom?: string };

// 只用于控制器登记的模拟 API：让下一条 edit 引用刚刚实际读到的版本。
export function materializeMockReply(original: MockReply, body: any): MockReply {
  const reply = structuredClone(original);
  if (!reply.versionFrom) return reply;
  const results = (body.messages ?? []).flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
  const read = results.findLast((b: any) => b.type === "tool_result" && b.tool_use_id === reply.versionFrom);
  if (!read || read.is_error || typeof read.content !== "string") throw new Error("模拟 edit 没有对应的成功读取");
  const payload = JSON.parse(read.content);
  if (payload.operation !== "read" || typeof payload.version !== "string" || !payload.version) throw new Error("模拟读取缺少文件版本");
  const edits = reply.content.filter(b => b.type === "tool_use" && b.name === "edit");
  if (!edits.length) throw new Error("versionFrom 没有对应 edit");
  for (const edit of edits) edit.input.base_version = payload.version;
  return reply;
}
