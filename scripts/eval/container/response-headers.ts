// 保留影响客户端退避和诊断的响应元数据，不转发认证、Cookie 或压缩长度。
const names = new Set(["content-type", "cache-control", "date", "retry-after", "retry-after-ms", "x-should-retry", "request-id", "x-request-id"]);
export function relayResponseHeaders(upstream: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of upstream) {
    if (names.has(name) || name.startsWith("anthropic-ratelimit-") || name.startsWith("anthropic-fast-") || name.startsWith("x-ratelimit-")) forwarded.set(name, value);
  }
  return forwarded;
}
