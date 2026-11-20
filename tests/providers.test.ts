import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APIClient } from "../src/api/client.ts";
import { requestBody } from "../src/api/providers.ts";
import { probeConnection } from "../src/api/wire.ts";
import { assembleConfig, endpoint, loadProfile, profilePath, readProfiles, saveProfiles, shellEnvironment, type Profile } from "../src/profiles.ts";
import { runSetup } from "../src/setup.ts";
import type { APIConfig } from "../src/config.ts";
import type { Message } from "../src/api/types.ts";

const signal = new AbortController().signal;
const call = { signal, effort: "medium" as const };
const config: APIConfig = { url: "https://provider.invalid/v1", apiKey: "test-secret", model: "model", timeoutMs: 1000, upstreamOAuth: false };
const sse = (...events: (string | object)[]): Response => new Response(events.map(
  value => "data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n",
).join(""), { headers: { "content-type": "text/event-stream" } });
const chat = (delta: object, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const responseTool = { id: "fc_1", type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"file.txt"}', status: "completed" };
const responseEvents = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { ...responseTool, arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '{"path":' },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '"file.txt"}' },
  { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: responseTool.arguments },
  { type: "response.output_item.done", output_index: 0, item: responseTool },
  { type: "response.completed", response: { id: "resp_1", status: "completed", output: [responseTool] } },
];
const toolResult = { type: "tool_result", tool_use_id: "call_1", content: "read receipt", is_error: false };

test("DeepSeek 分片工具入参、思考及工具结果在续轮保留", async () => {
  const selected: APIConfig = { ...config, protocol: "chat-completions", provider: "deepseek" };
  const client = new APIClient(selected, "system", {
    fetch: (async (_: Parameters<typeof fetch>[0], req?: RequestInit) => {
      expect(req?.headers).toMatchObject({ authorization: "Bearer test-secret" });
      expect(req?.redirect).toBe("error");
      return sse(
        chat({ reasoning_content: "verbatim plan" }),
        chat({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] }),
        chat({ tool_calls: [{ index: 0, function: { arguments: '"file.txt"}' } }] }),
        chat({}, "tool_calls"), "[DONE]",
      );
    }) as unknown as typeof fetch,
  });
  const result = await client.call([{ role: "user", content: "read" }], call);
  expect(result.stopReason).toBe("tool_use");
  expect(result.content.at(-1)).toEqual({ type: "tool_use", id: "call_1", name: "read", input: { path: "file.txt" } });
  const history: Message[] = [{ role: "assistant", content: result.content }, { role: "user", content: [toolResult] }];
  expect(requestBody(selected, "system", history, "medium", true).messages).toMatchObject([
    { role: "system", content: "system" },
    { role: "assistant", reasoning_content: "verbatim plan", tool_calls: [{ id: "call_1" }] },
    { role: "tool", tool_call_id: "call_1", content: "read receipt" },
  ]);
});

test("Responses 校验事件后重放无服务端状态的工具输出", async () => {
  const selected: APIConfig = { ...config, protocol: "openai-responses", provider: "openai" };
  const client = new APIClient(selected, "system", { fetch: (async () => sse(...responseEvents)) as unknown as typeof fetch });
  const result = await client.call([{ role: "user", content: "read" }], call);
  const history: Message[] = [{ role: "assistant", content: result.content }, { role: "user", content: [toolResult] }];
  expect(requestBody(selected, "system", history, "medium", true)).toMatchObject({
    store: false, include: ["reasoning.encrypted_content"],
    input: [responseTool, { type: "function_call_output", call_id: "call_1", output: "read receipt" }],
  });
  expect(result.content.at(-1)).toMatchObject({ type: "tool_use", id: "call_1", name: "read" });
});

test("拒绝缺工具标识、未完成或乱序的流", async () => {
  const chatConfig: APIConfig = { ...config, protocol: "chat-completions" };
  const responsesConfig: APIConfig = { ...config, protocol: "openai-responses" };
  for (const [selected, events] of [
    [chatConfig, [chat({ tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }, "tool_calls"), "[DONE]"]],
    [chatConfig, [chat({ content: "partial" })]],
    [responsesConfig, [responseEvents[0]!, responseEvents[2]!]],
    [responsesConfig, [...responseEvents.slice(0, -1), { type: "response.completed", response: { id: "resp_p", status: "completed", output: [responseTool] } }]],
  ] as const) {
    const client = new APIClient(selected, "system", { fetch: (async () => sse(...events)) as unknown as typeof fetch, maxRetries: 0 });
    await expect(client.call([], call)).rejects.toThrow();
  }
});

test("429 复用请求，普通 401 不重试且去掉回显的 Key", async () => {
  let requests = 0;
  const recorded: string[] = [];
  const client = new APIClient({ ...config, protocol: "chat-completions" }, "system", {
    fetch: (async () => {
      requests++;
      if (requests === 1) return new Response("limited", { status: 429, headers: { "retry-after": "0" } });
      return new Response("Account returned test-secret", { status: 401 });
    }) as unknown as typeof fetch,
    record: (kind, data) => recorded.push(JSON.stringify({ kind, data })),
    sleep: async () => {},
  });
  await expect(client.call([], call)).rejects.toThrow("HTTP 401");
  expect(requests).toBe(2);
  expect(recorded.join("")).not.toContain("test-secret");
  expect(recorded.join("")).toContain("retry_scheduled");
});

test("设置读取、取消及并发保存保留原配置，未设置时兼容原网关", async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-profiles-"));
  const env = { XDG_CONFIG_HOME: root, ANTHROPIC_API_KEY: "legacy-key", ANTHROPIC_BASE_URL: "https://legacy.invalid/api" };
  const path = profilePath(env);
  const unused = async () => { throw new Error("未要求输入"); };
  try {
    expect((await loadProfile(undefined, unused, env)).url).toBe("https://legacy.invalid/api/v1/messages");
    await expect(loadProfile("missing", unused, env)).rejects.toThrow("找不到");
    const answers = ["6", "", "", "n", "y", "y"];
    await runSetup({ write() {}, read: async () => answers.shift() ?? null, readSecret: unused }, "local", signal, env);
    const { raw, data } = readProfiles(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await loadProfile(undefined, unused, env)).apiKey).toBe("");
    await expect(runSetup({ write() {}, read: async () => null, readSecret: unused }, "local", signal, env)).rejects.toHaveProperty("name", "AbortError");
    expect(readProfiles(path).raw).toBe(raw);
    writeFileSync(path, raw + "\n");
    expect(() => saveProfiles(path, raw, data)).toThrow("已更新");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("端点与认证绑定，工具不继承已知 API Key", async () => {
  const official: Profile = { provider: "deepseek", protocol: "chat-completions", model: "deepseek-flash", auth: { type: "env", name: "OTHER_KEY" } };
  expect(endpoint(official)).toBe("https://api.deepseek.com/chat/completions");
  expect(() => endpoint({ ...official, baseUrl: "https://other.invalid/" })).toThrow();
  expect(() => endpoint({ ...official, provider: "custom", baseUrl: "http://example.org" })).toThrow();
  expect(() => endpoint({ ...official, provider: "custom", baseUrl: "https://key@example.org" })).toThrow();
  expect(() => assembleConfig({ ...official, provider: "bailian" }, "plan", "normal", {})).toThrow("专属 Key");
  const selected = assembleConfig(official, "profile", "test-secret", {});
  expect(shellEnvironment(selected, { OTHER_KEY: "test-secret", OPENAI_API_KEY: "o", COPY: "test-secret", PATH: "usr" })).toEqual({ PATH: "usr" });
  await probeConnection(selected, signal, (async (url: Parameters<typeof fetch>[0], input?: RequestInit) => {
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(input?.redirect).toBe("error");
    expect(JSON.parse(String(input?.body))).toMatchObject({ stream: false, messages: [{ role: "user", content: "Reply with OK." }] });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
  }) as unknown as typeof fetch);
});
