import { isObject, type JsonObject } from "../api/types.ts";

const inherited = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

export function childEnvironment(extra: string[]): Record<string, string> {
  return Object.fromEntries([...inherited, ...extra].flatMap(key => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export function terminate(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch {} }
}

export async function* events(stream: ReadableStream<Uint8Array>): AsyncGenerator<JsonObject> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      if (end > 8 * 1024 * 1024) throw new Error("本机代理事件超过大小限制。");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) throw new Error("本机代理返回了无效 JSON 事件。");
      yield value;
    }
    if (buffer.length > 8 * 1024 * 1024) throw new Error("本机代理事件超过大小限制。");
  }
  if ((buffer + decoder.decode()).trim()) throw new Error("本机代理的事件流中途断开。");
}
