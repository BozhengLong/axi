import { observeAPIError } from "../container/api-error.ts";

export function classifyExecution(status: string, events: any[]): string {
  if (status === "completed") return "completed";
  if (["budget_exhausted", "task_timeout", "workspace_disk_budget"].includes(status)) return "candidate_unfinished";
  let last = -1;
  for (let i = 0; i < events.length; i++) if (events[i].kind === "request" && events[i].data?.path?.endsWith("/messages")) last = i;
  const current = events.slice(last + 1);
  // 鉴权或未知协议不能使用上游整组补跑额度。只观察最后一次生成请求。
  if (current.some(e => e.kind === "response_headers" && [401, 403].includes(e.data?.status) || e.kind === "sse" && ["authentication_error", "permission_error"].includes(observeAPIError(e.data)?.errorType ?? ""))) return "authentication_failure";
  if (current.some(e => e.kind === "sse" && e.data?.type === "error" && !observeAPIError(e.data)?.retryable)) return "unclassified_failure";
  const external = current.some(e => e.kind === "upstream_error" ||
    (e.kind === "response_headers" && ([408, 429].includes(e.data.status) || e.data.status >= 500)) ||
    (e.kind === "sse" && observeAPIError(e.data)?.retryable));
  return last >= 0 && external ? "environment_indeterminate" : "unclassified_failure";
}
