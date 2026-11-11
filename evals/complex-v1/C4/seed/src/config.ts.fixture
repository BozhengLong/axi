export interface APIConfig {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): APIConfig {
  if (!env.ANTHROPIC_BASE_URL?.trim()) throw new Error("请设置 ANTHROPIC_BASE_URL");
  if (!env.ANTHROPIC_API_KEY?.trim()) throw new Error("请设置 ANTHROPIC_API_KEY");
  let url: URL;
  try { url = new URL(env.ANTHROPIC_BASE_URL.trim()); }
  catch { throw new Error("ANTHROPIC_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("ANTHROPIC_BASE_URL 不能包含认证信息、查询参数或片段");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1/messages") ? path : path.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`;
  return { url: url.toString(), apiKey: env.ANTHROPIC_API_KEY.trim(), model: "claude-opus-5-5", timeoutMs: 300_000 };
}
