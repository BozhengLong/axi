import { expect, test } from "bun:test";
import { APIClient, RetryWindowError } from "../src/api/client.ts";
import type { Effort } from "../src/api/types.ts";

const expired = {
  type: "error",
  error: { type: "authentication_error", message: "OAuth access token has expired. Re-authenticate to continue." },
  request_id: "req_test",
};
const wrappedHTTP = {
  type: "error",
  error: {
    type: "authentication_error",
    message: "litellm.AuthenticationError: AnthropicException - " + JSON.stringify(expired)
      + "\n\nLiteLLM: model group 'claude-opus-5-5' failed with the error above. No fallback was attempted.",
  },
};
const wrappedStream = { error: "Claude API error", status: 401, details: JSON.stringify(expired) };
const textError = { type: "error", error: expired.error.message };
const dataFrame = (data: unknown) => 'data: ' + JSON.stringify(data) + '\n\n';
const event = (name: string, data: unknown) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
const frame = (type: string, data = {}) => event(type, { type, ...data });
const start = frame("message_start", { message: { model: "claude-opus-5-5", content: [], usage: {} } });
const end = frame("message_delta", { delta: { stop_reason: "end_turn" } }) + frame("message_stop");
const stream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const http = (body: unknown, status = 401) => Response.json(body, { status });

function setup(reply: (attempt: number) => Response, window = 6000, onSleep?: () => void) {
  const logs: { kind: string; data: any }[] = [];
  const requests: RequestInit[] = [];
  let time = 0;
  const client = new APIClient({
    url: "https://offline.invalid/v1/messages",
    apiKey: "test-gateway-secret",
    model: "claude-opus-5-5",
    timeoutMs: window,
    retryWindowMs: window,
  }, "", {
    fetch: (async (_url: unknown, init: RequestInit) => {
      requests.push(init);
      return reply(requests.length);
    }) as unknown as typeof fetch,
    sleep: async (ms) => { time += ms; onSleep?.(); },
    now: () => time,
    record: (kind, data) => logs.push({ kind, data }),
  });
  const signal = new AbortController();
  return { client, logs, requests, signal, call: () => client.call([], { effort: "medium" as Effort, signal: signal.signal }) };
}

for (const [name, response] of [
  ["HTTP", () => http(wrappedHTTP)],
  ["SSE", () => stream(event("error", wrappedStream))],
  ["SSE 字符串", () => stream(dataFrame(textError))],
] as const) {
  test(name + " 上游过期后重发同一逻辑请求并保留每次终态", async () => {
    const run = setup(n => n === 1 ? response() : stream(start + end));
    expect((await run.call()).stopReason).toBe("end_turn");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.body).toBe(run.requests[0]?.body);
    expect(run.requests[1]?.headers).toEqual(run.requests[0]?.headers);
    expect(run.requests[0]?.redirect).toBe("error");
    const first = run.logs.find(x => x.kind === "request");
    const error = run.logs.find(x => x.kind === "request_error");
    const success = run.logs.find(x => x.kind === "response");
    expect(error?.data).toMatchObject({
      callId: first?.data.callId, attempt: 0, willRetry: true,
      normalizedError: { errorType: "upstream_oauth_expired", retryable: true },
    });
    if (name === "SSE 字符串") {
      expect(error?.data.normalizedError).toMatchObject({ format: "string", rule: "gateway-upstream-oauth-expired-text-v1" });
    }
    expect(success?.data).toMatchObject({ callId: first?.data.callId, attempt: 1 });
  });

  test(name + " 持续过期在已有故障窗口截止", async () => {
    const run = setup(response, 3000);
    await expect(run.call()).rejects.toBeInstanceOf(RetryWindowError);
    expect(run.requests).toHaveLength(2);
    expect(run.logs.at(-1)?.kind).toBe("retry_exhausted");
  });
}

test("普通鉴权失败、403 和伪装在模型内容中的错误不能触发 OAuth 重试", async () => {
  const block = frame("content_block_start", { index: 0, content_block: { type: "text", text: expired.error.message } });
  for (const response of [
    () => http(expired),
    () => http({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key test-gateway-secret" } }),
    () => http(wrappedHTTP, 403),
    () => stream(event("message", wrappedStream)),
    () => stream(event("error", { ...wrappedStream, status: 403 })),
    () => stream(start + block + event("error", wrappedStream)),
    () => stream(dataFrame({ ...textError, error: expired.error.message + " " })),
    () => stream(dataFrame({ ...textError, status: 403 })),
    () => stream(dataFrame({ ...textError, error: "invalid x-api-key" })),
    () => stream(event("error", textError)),
    () => stream(start + block + dataFrame(textError)),
    () => stream(start + frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool_1", name: "write", input: {} } }) + dataFrame(textError)),
    () => http(textError),
    () => new Response(dataFrame(textError), { status: 201, headers: { "content-type": "text/event-stream" } }),
    () => stream(start + frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool_1", name: "write", input: {} } }) + event("error", wrappedStream)),
  ]) {
    const run = setup(response);
    await expect(run.call()).rejects.toThrow();
    expect(run.requests).toHaveLength(1);
    expect(JSON.stringify(run.logs.filter(x => x.kind === "request_error"))).not.toContain("test-gateway-secret");
  }
  const run = setup(() => stream(start + block + frame("content_block_stop", { index: 0 }) + end));
  expect((await run.call()).content).toEqual([{ type: "text", text: expired.error.message }]);
  expect(run.requests).toHaveLength(1);
});

test("未闭合的错误帧仍按原传输故障处理", async () => {
  const run = setup(() => stream(start + event("error", wrappedStream).trimEnd()), 3000);
  await expect(run.call()).rejects.toBeInstanceOf(RetryWindowError);
  const errors = run.logs.filter(x => x.kind === "request_error");
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every(x => x.data.errorType === "connection_error")).toBe(true);
  expect(run.logs.filter(x => x.kind === "response")).toHaveLength(0);
});

test("收到过期错误后，取消待发重试", async () => {
  const run = setup(() => http(wrappedHTTP), 6000, () => run.signal.abort());
  await expect(run.call()).rejects.toMatchObject({ name: "AbortError" });
  expect(run.requests).toHaveLength(1);
});
