import { isObject } from "./types.ts";

export interface NormalizedAPIError {
  errorType: string;
  message: string;
  format: "structured" | "string" | "malformed";
  rule: "structured-type" | "gateway-rate-limit-v1" | "unrecognized";
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
