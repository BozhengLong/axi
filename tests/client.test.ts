import { describe, expect, test } from "bun:test";
import { APIClient, retryAfter, sleep } from "../src/api/client.ts";
import { loadConfig } from "../src/config.ts";
import { activeSignal, event, streamFixture } from "./fixtures.ts";

const config = { url: "http://127.0.0.1/v1/messages", apiKey: "fake-key", model: "claude-opus-5-5", timeoutMs: 5000 };
const sse = (text = streamFixture()) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const fakeFetch = (handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response> | Response) => handler as typeof fetch;

describe("API 客户端", () => {
  test("请求携带 D2/D4 参数、原样历史和正确认证头", async () => {
    const messages = [{ role: "user" as const, content: "你好" }];
    const client = new APIClient(config, "system", { fetch: fakeFetch((_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(body.output_config).toEqual({ effort: "medium" });
      expect(body.messages).toEqual(messages);
      expect(body.tools[0].eager_input_streaming).toBe(true);
      expect(body.max_tokens).toBe(64000);
      expect(new Headers(init!.headers).get("x-api-key")).toBe("fake-key");
      expect(new Headers(init!.headers).get("anthropic-version")).toBe("2023-06-01");
      return sse();
    }) });
    expect((await client.call(messages, { effort: "medium", signal: activeSignal() })).usage.output_tokens).toBe(8);
    expect(messages).toEqual([{ role: "user", content: "你好" }]);
  });
  test("最多重试三次，遵守 retry-after 和指数退避", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new APIClient(config, "", {
      fetch: fakeFetch(() => { calls++; return calls === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "0.125" } }) : new Response("busy", { status: 529 }); }),
      sleep: async ms => { delays.push(ms); },
    });
    await expect(client.call([], { effort: "medium", signal: activeSignal() })).rejects.toThrow("529");
    expect(calls).toBe(4);
    expect(delays).toEqual([125, 2000, 4000]);
  });
  test("401 和流中认证错误不重试，也不输出认证 key", async () => {
    for (const reply of [() => new Response("fake-key", { status: 401 }), () => sse(event("error", { error: { type: "authentication_error", message: "fake-key" } }))]) {
      let calls = 0;
      const client = new APIClient(config, "", { fetch: fakeFetch(() => { calls++; return reply(); }) });
      await expect(client.call([], { effort: "high", signal: activeSignal() })).rejects.toThrow("认证信息已隐藏");
      expect(calls).toBe(1);
    }
  });
  test("流中临时错误和断流可以重试，丢弃第一次的半截内容", async () => {
    for (const broken of [event("error", { error: { type: "overloaded_error", message: "busy" } }), streamFixture().replace(event("message_stop"), "")]) {
      let calls = 0;
      const client = new APIClient(config, "", { fetch: fakeFetch(() => sse(++calls === 1 ? broken : streamFixture())), sleep: async () => {} });
      const result = await client.call([], { effort: "medium", signal: activeSignal() });
      expect(calls).toBe(2);
      expect(result.content).toEqual([{ type: "text", text: "完成" }]);
    }
  });
  test("message_stop 后无需等待服务端关闭连接", async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(streamFixture())); }, cancel() { cancelled = true; } });
    const client = new APIClient(config, "", { fetch: fakeFetch(() => new Response(body, { headers: { "content-type": "text/event-stream" } })) });
    await client.call([], { effort: "medium", signal: activeSignal() });
    expect(cancelled).toBe(true);
  });
  test("退避期间可中止，不会再发请求", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = new APIClient(config, "", { fetch: fakeFetch(() => { calls++; return new Response("busy", { status: 500 }); }) });
    await expect(client.call([], { effort: "medium", signal: controller.signal, onRetry: () => controller.abort() })).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(sleep(10000, controller.signal)).rejects.toThrow();
  });
  test("请求期间中止不重试；请求超时可以重试但受上限约束", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pendingFetch = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      calls++;
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const first = new APIClient(config, "", { fetch: pendingFetch });
    const pending = first.call([], { effort: "medium", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
    const timed = new APIClient({ ...config, timeoutMs: 10 }, "", { fetch: pendingFetch, sleep: async () => {}, maxRetries: 1 });
    await expect(timed.call([], { effort: "medium", signal: activeSignal() })).rejects.toThrow("请求超过");
    expect(calls).toBe(3);
  });
  test("地址规范化和 retry-after 日期", () => {
    for (const base of ["https://example.com", "https://example.com/", "https://example.com/v1", "https://example.com/v1/messages"]) {
      expect(loadConfig({ ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "fake" }).url).toBe("https://example.com/v1/messages");
    }
    expect(() => loadConfig({})).toThrow("ANTHROPIC_BASE_URL");
    expect(retryAfter("Wed, 01 Jan 2025 00:00:02 GMT", Date.parse("2025-01-01T00:00:00Z"))).toBe(2000);
    expect(retryAfter("invalid")).toBeUndefined();
  });
});
