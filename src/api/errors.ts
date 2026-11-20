import { isObject } from "./types.ts";

export interface NormalizedAPIError {
  errorType: string;
  message: string;
  format: "structured" | "string" | "malformed";
  rule: "structured-type" | "gateway-rate-limit-v1" | "gateway-upstream-oauth-expired-v1" | "gateway-upstream-oauth-expired-text-v1" | "unrecognized";
  retryable: boolean;
}

// 只接受已留证的完整文本。普通内容不能调用此入口；未知文本不猜测为限流。
export function normalizeAPIError(error: unknown): NormalizedAPIError {
  const format = typeof error === "string" ? "string" : isObject(error) ? "structured" : "malformed";
  const message = typeof error === "string" ? error : isObject(error) && typeof error.message === "string" ? error.message : `未知流式 API 错误：${JSON.stringify(error) ?? "缺少 error"}`;
  if (error === "This request would exceed your account's rate limit. Please try again later.") {
    return { errorType: "rate_limit_error", message, format, rule: "gateway-rate-limit-v1", retryable: true };
  }
  const errorType = isObject(error) && typeof error.type === "string" ? error.type : "unknown_error";
  return { errorType, message, format, rule: errorType === "unknown_error" ? "unrecognized" : "structured-type", retryable: ["overloaded_error", "rate_limit_error", "api_error", "connection_error"].includes(errorType) };
}

const expiredMessage = "OAuth access token has expired. Re-authenticate to continue.";
const liteLLMPrefix = "litellm.AuthenticationError: AnthropicException - ";

function parseObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function authenticationError(envelope: unknown): Record<string, unknown> | undefined {
  if (!isObject(envelope) || envelope.type !== "error" || !isObject(envelope.error)) return undefined;
  return envelope.error.type === "authentication_error" ? envelope.error : undefined;
}

function expiredOAuth(envelope: unknown): NormalizedAPIError | undefined {
  if (authenticationError(envelope)?.message !== expiredMessage) return undefined;
  return {
    errorType: "upstream_oauth_expired",
    message: expiredMessage,
    format: "structured",
    rule: "gateway-upstream-oauth-expired-v1",
    retryable: true,
  };
}

// 只从网关已验证的 HTTP 401 包装中提取上游错误。
export function upstreamOAuthHTTP(status: number, body: string): NormalizedAPIError | undefined {
  if (status !== 401) return undefined;
  const message = authenticationError(parseObject(body))?.message;
  if (typeof message !== "string" || !message.startsWith(liteLLMPrefix)) return undefined;
  const [upstream] = message.slice(liteLLMPrefix.length).split("\n\nLiteLLM:", 1);
  return expiredOAuth(parseObject(upstream));
}

// 有些网关的错误通过事件名标识，JSON 数据本身没有 type。
export function upstreamOAuthStream(event: string, value: unknown): NormalizedAPIError | undefined {
  if (!isObject(value)) return undefined;
  // 仅识别已经实测的两字段错误帧，避免给其他鉴权失败开启重试。
  if (event === "message" && value.type === "error" && value.error === expiredMessage
      && Object.keys(value).length === 2) {
    return {
      errorType: "upstream_oauth_expired",
      message: expiredMessage,
      format: "string",
      rule: "gateway-upstream-oauth-expired-text-v1",
      retryable: true,
    };
  }
  if (event !== "error" || (value.type !== undefined && value.type !== "error")
      || value.status !== 401 || value.error !== "Claude API error") return undefined;
  return expiredOAuth(parseObject(value.details));
}
