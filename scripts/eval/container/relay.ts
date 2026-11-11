import { fatalFaults } from "./faults.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { RequestBudget } from "./budget.ts";
import { relayResponseHeaders } from "./response-headers.ts";
import { materializeMockReply, type MockReply } from "./mock-reply.ts";

type Tool = { id: string; name: string; input: Record<string, unknown>; approved?: boolean; messageComplete?: boolean };
type Reply = MockReply;
type Run = { id: string; token: string; mock?: Reply[]; policy: string; denied: boolean; revoked: boolean; requests: number; budget: RequestBudget; events: number; evidenceBytes: number; tools: Tool[]; responses: any[]; permissions: any[]; faults: string[]; transportIssues: string[]; controllers: Set<AbortController>; started: number };
const runs = new Map<string, Run>();
const admin = process.env.EVAL_ADMIN_TOKEN!;
const upstream = process.env.EVAL_UPSTREAM_URL!;
const key = process.env.EVAL_UPSTREAM_KEY!;
const secretValues = [admin, key, upstream, upstream ? new URL(upstream).host : ""].filter(Boolean);
const redact = (value: unknown) => {
  let text = JSON.stringify(value);
  for (const secret of secretValues) text = text.replaceAll(secret, "[REDACTED]");
  return text;
};
function log(run: Run, kind: string, data: unknown) {
  if (run.faults.includes("evidence_limit")) return;
  const line = redact({ time: new Date().toISOString(), kind, data }) + "\n";
  if (++run.events > 100000 || run.evidenceBytes + Buffer.byteLength(line) > 200 * 1024 * 1024) {
    run.faults.push("evidence_limit");
    appendFileSync(`/evidence/${run.id}.jsonl`, JSON.stringify({ time: new Date().toISOString(), kind: "truncated", data: { reason: "API trace 超过证据上限" } }) + "\n", { mode: 0o600 });
    return;
  }
  run.evidenceBytes += Buffer.byteLength(line);
  appendFileSync(`/evidence/${run.id}.jsonl`, line, { mode: 0o600 });
}
function view(run: Run) {
  return { id: run.id, revoked: run.revoked, requests: run.requests, budget: run.budget, activeRequests: run.controllers.size, tools: run.tools, responses: run.responses, permissions: run.permissions, faults: run.faults, transportIssues: run.transportIssues };
}
function wire(reply: Reply) {
  const event = (type: string, fields: any = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  let text = event("message_start", { message: { id: `msg_eval_${crypto.randomUUID()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  reply.content.forEach((block, index) => {
    const field = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : "input";
    text += event("content_block_start", { index, content_block: { ...block, [field]: field === "input" ? {} : "" } });
    text += event("content_block_delta", { index, delta: field === "input" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: `${field}_delta`, [field]: block[field] } });
    text += event("content_block_stop", { index });
  });
  return text + event("message_delta", { delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }) + event("message_stop");
}
function decide(run: Run, name: string, input: any, id?: string) {
  if (run.faults.includes("evidence_limit")) return { behavior: "deny", message: "证据收集超限，本轮停止执行。" };
  const stable = (v: any): string => v && typeof v === "object" ? Array.isArray(v) ? `[${v.map(stable)}]` : `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}` : JSON.stringify(v);
  const normalized = (value: any) => {
    if (name.toLowerCase() !== "bash" || typeof value.command !== "string") return value;
    // Claude Code 会移除等于当前工作目录的前置 cd。只接受已实测的这一种等价变换。
    return { ...value, command: value.command.replace(/^cd \/task && /, "") };
  };
  // 有原生 tool_use_id 时，以该 ID 关联来源，并检查实际执行参数的权限范围。
  // Claude Code 会补默认值、解码 Unicode 转义；不能用原始字节相等错误地拒绝这些调用。
  const tool = [...run.tools].reverse().find(t => !t.approved && t.name.toLowerCase() === name.toLowerCase() && (id ? t.id === id : stable(normalized(t.input)) === stable(normalized(input))));
  if (!tool) {
    run.faults.push("permission_did_not_match_completed_tool");
    log(run, "permission_mismatch", { name, input, id, pending: run.tools.filter(t => !t.approved) });
    return { behavior: "deny", message: "未匹配到当前完整工具调用，本次不执行。" };
  }
  tool.approved = true;
  let reason = "";
  if (!["bash", "read", "write", "edit", "glob", "grep"].includes(name.toLowerCase())) reason = "本轮只允许本地编码工具。";
  if (input.run_in_background) reason = "本轮不运行后台服务。";
  const file = input.file_path ?? input.path;
  if (typeof file === "string" && file.startsWith("/") && !file.startsWith("/task/")) reason = "操作范围限于 /task。";
  // 拒绝专项故意拒绝第一次工具调用，题面要求该调用直接执行改写。
  if (run.policy === "deny-first" && !run.denied) { run.denied = true; reason = "保留原文件 keep.txt，不要修改或删除它。请把新内容另存为 copy.txt。"; }
  const result = reason ? { behavior: "deny", message: reason } : { behavior: "allow", updatedInput: input };
  const entry = { toolUseId: tool.id, toolName: name, input, originalInput: tool.input, transformed: stable(input) !== stable(tool.input), ...result };
  run.permissions.push(entry); log(run, "permission", entry);
  return result;
}

mkdirSync("/evidence", { recursive: true, mode: 0o700 });
Bun.serve({ hostname: "0.0.0.0", port: 8787, idleTimeout: 255, maxRequestBodySize: 16 * 1024 * 1024, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/control/")) {
    if (req.headers.get("authorization") !== `Bearer ${admin}`) return new Response("denied", { status: 403 });
    const data: any = req.method === "POST" ? await req.json() : {};
    if (url.pathname === "/control/register") {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(data.id) || !data.token || runs.has(data.id)) return new Response("invalid run", { status: 400 });
      const budget = new RequestBudget(data.maxRounds ?? 1, data.maxPerRound ?? 50, data.maxTotal ?? 50);
      const run: Run = { id: data.id, token: data.token, mock: data.mock, policy: data.policy ?? "normal", denied: false, revoked: false, requests: 0, budget, events: 0, evidenceBytes: 0, tools: [], responses: [], permissions: [], faults: [], transportIssues: [], controllers: new Set(), started: performance.now() };
      runs.set(run.id, run); log(run, "registered", { id: run.id, policy: run.policy, mock: !!run.mock });
      return Response.json({ ok: true });
    }
    const run = runs.get(data.id ?? url.searchParams.get("id")!);
    if (!run) return new Response("unknown", { status: 404 });
    if (url.pathname === "/control/next-round") {
      if (run.controllers.size || run.revoked || fatalFaults(run.faults).length) return new Response("run is not idle and healthy", { status: 409 });
      try { run.budget.advance(data.expectedRound); }
      catch (error) { return new Response(String(error), { status: 409 }); }
      log(run, "round_started", { round: run.budget.round, budget: run.budget });
    }
    if (url.pathname === "/control/revoke") { run.revoked = true; for (const ctrl of run.controllers) ctrl.abort(); log(run, "revoked", {}); }
    if (url.pathname === "/control/permission") return Response.json(decide(run, data.tool_name, data.input, data.tool_use_id));
    return Response.json(view(run));
  }
  const token = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "");
  const run = [...runs.values()].find(r => r.token === token && !r.revoked);
  if (!run) return new Response("invalid or expired run", { status: 401 });
  if (url.pathname === "/permission" && req.method === "POST") {
    const body: any = await req.json();
    return Response.json(decide(run, body.tool_name, body.input, body.tool_use_id));
  }
  if (!["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname) || req.method !== "POST") return new Response("path denied", { status: 403 });
  const withinBudget = run.budget.consume(url.pathname.endsWith("count_tokens"));
  run.requests = run.budget.requests;
  const requestSequence = run.requests, requestRound = run.budget.round;
  if (!withinBudget) { if (!run.faults.includes("request_budget")) run.faults.push("request_budget"); log(run, "budget_exhausted", run.budget); return Response.json({ type: "error", error: { type: "invalid_request_error", message: "评测请求上限" } }, { status: 400 }); }
  const bodyText = await req.text();
  const body = JSON.parse(bodyText);
  log(run, "request", { sequence: requestSequence, round: requestRound, path: url.pathname, body });
  if (body.model !== "claude-opus-5-5") { run.faults.push(`model_mismatch:${body.model}`); return new Response("model mismatch", { status: 400 }); }
  if (url.pathname.endsWith("count_tokens") && run.mock) return Response.json({ input_tokens: 10 });
  const controller = new AbortController(); run.controllers.add(controller);
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 360000);
  try {
    let response: Response;
    if (run.mock) {
      const selected = run.mock.shift();
      if (!selected) return new Response("mock exhausted", { status: 400 });
      if (selected.connectionError) throw new Error("simulated upstream connection failure");
      const reply = materializeMockReply(selected, body);
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      response = !body.stream && !reply.raw
        ? Response.json({ id: `msg_eval_${crypto.randomUUID()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: reply.content, stop_reason: reply.stopReason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } })
        : new Response(reply.raw ?? wire(reply), { headers: { "content-type": "text/event-stream" } });
    } else {
      const target = new URL(upstream);
      if (url.pathname.endsWith("count_tokens")) target.pathname += "/count_tokens";
      // 转发必要协议头，认证固定来自独立环境，不接受任务指定的上游地址。
      const headers = new Headers({ "content-type": "application/json", "x-api-key": key, "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01" });
      for (const name of ["anthropic-beta", "accept", "user-agent"]) if (req.headers.has(name)) headers.set(name, req.headers.get(name)!);
      response = await fetch(target, { method: "POST", headers, body: bodyText, redirect: "error", signal: controller.signal });
    }
    const forwardedHeaders = relayResponseHeaders(response.headers);
    // 与错误正文保持相同的凭据边界；保留客户端退避所需的正常值。
    for (const [name, value] of forwardedHeaders) forwardedHeaders.set(name, JSON.parse(redact({ value })).value);
    log(run, "response_headers", { sequence: requestSequence, round: requestRound, status: response.status, headers: Object.fromEntries(forwardedHeaders) });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const text = await response.text();
      const safe = JSON.parse(redact({ text })).text;
      log(run, "http_result", { status: response.status, text: safe });
      // Claude Code 可能将失败的流式请求改为普通 JSON 重试。保留该行为，并解析完整消息供授权配对。
      if (response.ok && url.pathname === "/v1/messages") {
        const message = JSON.parse(text);
        if (message.type === "message" && Array.isArray(message.content)) {
          const result = { model: message.model, content: message.content, usage: message.usage ?? {}, stopReason: message.stop_reason, requestMs: performance.now() - started, transport: "json" };
          run.responses.push(result);
          for (const block of message.content) if (block.type === "tool_use") run.tools.push({ id: block.id, name: block.name, input: block.input, messageComplete: true });
          log(run, "complete_response", result);
        }
      }
      clearTimeout(timer); run.controllers.delete(controller);
      if (!forwardedHeaders.has("content-type")) forwardedHeaders.set("content-type", "application/json");
      return new Response(safe, { status: response.status, headers: forwardedHeaders });
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let buffer = "", bytes = 0;
    const blocks: any[] = []; const partials: Record<number, string> = {};
    const result: any = { content: blocks, usage: {}, model: "", stopReason: "", requestMs: 0 };
    const parse = (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n\n")) {
        const index = buffer.indexOf("\n\n"), frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        log(run, "raw_sse_frame", { frame });
        const payload = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (!payload) continue;
        if (payload.trim() === "[DONE]") { log(run, "sse_marker", { value: "[DONE]" }); continue; }
        const e = JSON.parse(payload); log(run, "sse", e);
        if (e.error || e.type === "error") { run.transportIssues.push(`api_event:${e.status ?? e.error?.type ?? "unknown"}`); }
        if (e.type === "message_start") { result.model = e.message.model; Object.assign(result.usage, e.message.usage); }
        if (e.type === "content_block_start") blocks[e.index] = structuredClone(e.content_block);
        if (e.type === "content_block_delta") {
          const b = blocks[e.index], d = e.delta;
          if (d.type === "input_json_delta") partials[e.index] = (partials[e.index] ?? "") + d.partial_json;
          if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
          if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
          if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
        }
        if (e.type === "content_block_stop") {
          if (partials[e.index]) blocks[e.index].input = JSON.parse(partials[e.index]!);
          // Claude Code 可在单个工具块完整后请求授权，不必等整个 message_stop。
          const b = blocks[e.index];
          if (b?.type === "tool_use") run.tools.push({ id: b.id, name: b.name, input: b.input, messageComplete: false });
        }
        if (e.type === "message_delta") { result.stopReason = e.delta.stop_reason; Object.assign(result.usage, e.usage); }
        if (e.type === "message_stop") {
          result.requestMs = performance.now() - started;
          run.responses.push(result);
          for (const b of blocks) if (b?.type === "tool_use") { const t = run.tools.find(t => t.id === b.id); if (t) t.messageComplete = true; }
          log(run, "complete_response", result);
        }
      }
    };
    const stream = new ReadableStream<Uint8Array>({ async pull(out) {
      try {
        const item = await reader.read();
        if (item.done) { parse(decoder.decode()); if (buffer) log(run, "sse_tail", { frame: buffer, incomplete: true }); out.close(); clearTimeout(timer); run.controllers.delete(controller); return; }
        bytes += item.value.byteLength;
        if (bytes > 200 * 1024 * 1024) throw new Error("流证据超过上限");
        // 观察器不能改变产品收到的原始字节；失败只留证。后续授权仍必须关联有效工具。
        try { parse(decoder.decode(item.value, { stream: true })); }
        catch (error) { run.transportIssues.push("observer_parse_error"); log(run, "observer_parse_error", { message: String(error) }); }
        out.enqueue(item.value);
      } catch { if (buffer) log(run, "sse_tail", { frame: buffer, incomplete: true }); run.transportIssues.push("upstream_stream_error"); out.error(new Error("relay stream failure")); controller.abort(); clearTimeout(timer); run.controllers.delete(controller); }
    }, async cancel() { controller.abort(); clearTimeout(timer); run.controllers.delete(controller); await reader.cancel(); } });
    if (!forwardedHeaders.has("cache-control")) forwardedHeaders.set("cache-control", "no-cache");
    return new Response(stream, { status: response.status, headers: forwardedHeaders });
  } catch (error) {
    clearTimeout(timer); run.controllers.delete(controller); run.faults.push("upstream_connection");
    log(run, "upstream_error", { message: String(error) });
    return Response.json({ type: "error", error: { type: "api_error", message: "评测转发服务无法完成上游请求" } }, { status: 502 });
  }
} });
console.log("evaluation relay ready");
