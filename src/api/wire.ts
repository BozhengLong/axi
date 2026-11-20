import type { APIConfig } from "../config.ts";
import { isObject } from "./types.ts";

export function requestHeaders(config: APIConfig, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  if (!config.protocol || config.protocol === "anthropic-messages") {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

export function redact(text: string, secret: string): string {
  if (!secret) return text;
  const replacement = "[认证信息已隐藏]";
  return text.replaceAll(secret, replacement)
    .replaceAll(JSON.stringify(secret).slice(1, -1), replacement);
}

export async function probeConnection(config: APIConfig, signal: AbortSignal, request = fetch): Promise<void> {
  const prompt = "Reply with OK.";
  const protocol = config.protocol ?? "anthropic-messages";
  const common = { model: config.model, stream: false };
  const messages = [{ role: "user", content: prompt }];
  const body = protocol === "openai-responses" ? { ...common, input: prompt, store: false, max_output_tokens: 256 }
    : { ...common, messages, max_tokens: 1024 };
  let response: Response;
  try {
    response = await request(config.url, {
      method: "POST", redirect: "error", headers: requestHeaders(config, false),
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("无法连接模型端点。请检查地址、服务器状态和网络。");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const reason = status === 401 || status === 403 ? "认证或模型访问权限失败"
      : status === 404 ? "端点或模型不存在" : status === 429 ? "请求受到限流或额度限制" : "提供商未接受测试请求";
    throw new Error(`连通测试失败（HTTP ${status}）：${reason}。`);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error("连通测试未返回有效 JSON。"); }
  const hasText = (items: unknown): boolean => Array.isArray(items) &&
    items.some(item => isObject(item) && typeof item.text === "string" && !!item.text.trim());
  let complete = false;
  if (isObject(data)) {
    if (protocol === "anthropic-messages") {
      complete = data.stop_reason === "end_turn" && hasText(data.content);
    } else if (protocol === "openai-responses") {
      complete = data.status === "completed" && Array.isArray(data.output) &&
        data.output.some(item => isObject(item) && item.type === "message" && hasText(item.content));
    } else {
      const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
      complete = isObject(choice) && choice.finish_reason === "stop" && isObject(choice.message) &&
        typeof choice.message.content === "string" && !!choice.message.content.trim();
    }
  }
  if (!complete) throw new Error("连通测试未返回完整文本。请检查指定的协议和模型。");
}
