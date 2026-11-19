// 独立观察器遵循 docs/guides/api-error-contract.md，不加载产品解析器。
export function observeAPIError(event: any) {
  if (!event || event.type !== "error") return undefined;
  const raw = event.error;
  const structured = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const format = typeof raw === "string" ? "string" : structured ? "structured" : "malformed";
  const known = raw === "This request would exceed your account's rate limit. Please try again later.";
  const errorType = known ? "rate_limit_error" : structured && typeof raw.type === "string" ? raw.type : "unknown_error";
  return { errorType, message: typeof raw === "string" ? raw : structured && typeof raw.message === "string" ? raw.message : `未知流式 API 错误：${JSON.stringify(raw) ?? "缺少 error"}`, format, rule: known ? "gateway-rate-limit-v1" : errorType === "unknown_error" ? "unrecognized" : "structured-type", retryable: ["rate_limit_error", "overloaded_error", "api_error", "connection_error"].includes(errorType) };
}


const expiredMessage = "OAuth access token has expired. Re-authenticate to continue.";
const liteLLMPrefix = "litellm.AuthenticationError: AnthropicException - ";

function parseJSON(text: unknown): any {
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function oauthError(envelope: any, transport: "http" | "sse") {
  if (envelope?.type !== "error" || envelope.error?.type !== "authentication_error"
      || envelope.error.message !== expiredMessage) return undefined;
  return { errorType: "upstream_oauth_expired", message: expiredMessage, format: "structured",
    rule: "gateway-upstream-oauth-expired-v1", retryable: true, transport };
}

// 独立检查代理接收的错误。保留原始帧及 HTTP 正文作为核对来源。
export function observeOAuthHTTP(status: number, text: string) {
  if (status !== 401) return undefined;
  const envelope = parseJSON(text);
  const message = envelope?.error?.message;
  if (envelope?.type !== "error" || envelope.error?.type !== "authentication_error"
      || typeof message !== "string" || !message.startsWith(liteLLMPrefix)) return undefined;
  const json = message.slice(liteLLMPrefix.length).split("\n\nLiteLLM:", 1)[0];
  return oauthError(parseJSON(json), "http");
}

export function observeOAuthStream(eventName: string, value: any) {
  if (eventName === "message" && value?.type === "error" && value.error === expiredMessage
      && Object.keys(value).length === 2) {
    return { errorType: "upstream_oauth_expired", message: expiredMessage, format: "string",
      rule: "gateway-upstream-oauth-expired-text-v1", retryable: true, transport: "sse" };
  }
  if (eventName !== "error" || (value?.type !== undefined && value.type !== "error")
      || value?.status !== 401 || value.error !== "Claude API error") return undefined;
  return oauthError(parseJSON(value.details), "sse");
}
