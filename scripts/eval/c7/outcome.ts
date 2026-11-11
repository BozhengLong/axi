export function classifyExecution(status: string, events: any[]): string {
  if (status === "completed") return "completed";
  if (["budget_exhausted", "task_timeout", "workspace_disk_budget"].includes(status)) return "candidate_unfinished";
  let last = -1;
  for (let i = 0; i < events.length; i++) if (events[i].kind === "request" && events[i].data?.path?.endsWith("/messages")) last = i;
  const current = events.slice(last + 1);
  const external = current.some(e => e.kind === "upstream_error" ||
    (e.kind === "response_headers" && ([401, 403, 408, 429].includes(e.data.status) || e.data.status >= 500)) ||
    (e.kind === "sse" && e.data?.type === "error" && ["overloaded_error", "rate_limit_error", "api_error", "connection_error", "authentication_error"].includes(e.data.error?.type)));
  return last >= 0 && external ? "environment_indeterminate" : "unclassified_failure";
}
