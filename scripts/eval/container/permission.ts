// Claude Code 的权限适配器；只转交当前调用，不自行推断授权。
const base = process.env.ANTHROPIC_BASE_URL!;
const token = process.env.ANTHROPIC_API_KEY!;
const send = (id: unknown, result: unknown) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
let buffer = "";
const decoder = new TextDecoder();
for await (const bytes of Bun.stdin.stream()) {
  buffer += decoder.decode(bytes, { stream: true });
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") send(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "axi-eval-permissions", version: "1.0.0" } });
    else if (msg.method === "ping") send(msg.id, {});
    else if (msg.method === "tools/list") send(msg.id, { tools: [{ name: "approve", description: "评测控制器的逐次权限决定", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object", additionalProperties: true }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] });
    else if (msg.method === "tools/call") {
      try {
        const response = await fetch(`${base}/permission`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: JSON.stringify(msg.params.arguments), signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`权限控制器 HTTP ${response.status}`);
        const decision = await response.json();
        send(msg.id, { content: [{ type: "text", text: JSON.stringify(decision) }] });
      } catch { send(msg.id, { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "权限控制器异常，本次不执行。" }) }] }); }
    } else console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
  }
}
