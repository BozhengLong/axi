import { expect, test } from "bun:test";
import { APIClient } from "../../../src/api/client.ts";
import { relayResponseHeaders } from "../container/response-headers.ts";

test("保留 Retry-After 后，真实 APIClient 使用上游退避值", async () => {
  const upstream = new Headers({ "content-type": "application/json", "retry-after": "7" });
  async function attempt(preserve: boolean) {
    const delays: number[] = []; let requests = 0;
    const client = new APIClient({ url: "http://synthetic.invalid/v1/messages", apiKey: "synthetic-key", model: "claude-opus-5-5", timeoutMs: 1000 }, "test", {
      maxRetries: 1,
      fetch: (async () => {
        requests++;
        return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"synthetic limit"}}', { status: 429, headers: preserve ? relayResponseHeaders(upstream) : { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      sleep: async ms => { delays.push(ms); },
    });
    await expect(client.call([{ role: "user", content: "probe" }], { signal: new AbortController().signal, effort: "medium" })).rejects.toThrow("HTTP 429");
    return { delays, requests };
  }
  expect(await attempt(false)).toEqual({ delays: [1000], requests: 2 });
  expect(await attempt(true)).toEqual({ delays: [7000], requests: 2 });
});

test("保留限流和请求 ID，隔离认证、Cookie、压缩长度及逐跳响应头", () => {
  const headers = relayResponseHeaders(new Headers({
    "retry-after": "0", "retry-after-ms": "250", "x-should-retry": "true", "request-id": "req-synthetic", "content-type": "text/event-stream",
    "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": "2026-11-11T08:00:00Z", "anthropic-fast-token-limit": "100", "x-ratelimit-remaining": "0",
    authorization: "Bearer synthetic", "x-api-key": "synthetic", "set-cookie": "session=synthetic", "content-encoding": "gzip", "content-length": "100", connection: "keep-alive",
  }));
  expect(headers.get("retry-after")).toBe("0"); expect(headers.get("retry-after-ms")).toBe("250"); expect(headers.get("x-should-retry")).toBe("true");
  expect(headers.get("request-id")).toBe("req-synthetic"); expect(headers.get("content-type")).toBe("text/event-stream");
  expect(headers.get("anthropic-ratelimit-requests-remaining")).toBe("0"); expect(headers.get("anthropic-ratelimit-requests-reset")).toBe("2026-11-11T08:00:00Z");
  expect(headers.get("anthropic-fast-token-limit")).toBe("100"); expect(headers.get("x-ratelimit-remaining")).toBe("0");
  for (const name of ["authorization", "x-api-key", "set-cookie", "content-encoding", "content-length", "connection"]) expect(headers.has(name)).toBe(false);
});
