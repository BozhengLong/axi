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
