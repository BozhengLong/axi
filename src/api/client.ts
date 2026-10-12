import type { APIConfig } from "../config.ts";
import { SSEParser } from "./sse.ts";
import { MessageAssembler, ProtocolError, StreamAPIError } from "./stream.ts";
import { abortError, errorMessage, noLog, type Effort, type Message, type ModelResponse, type RecordLog, type StreamCallbacks } from "./types.ts";
import { bashTool } from "../tools/bash.ts";

export class HTTPError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) { super(message); }
}

export interface CallOptions extends StreamCallbacks {
  signal: AbortSignal;
  effort: Effort;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}
export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  record?: RecordLog;
  maxRetries?: number;
  eagerInputStreaming?: boolean;
  onRawLine?: (line: string) => void;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function retryable(error: unknown): boolean {
  if (error instanceof HTTPError) return error.status === 429 || error.status >= 500;
  if (error instanceof StreamAPIError) return ["overloaded_error", "rate_limit_error", "api_error", "connection_error"].includes(error.errorType);
  return error instanceof TypeError || (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name));
}

export class APIClient {
  private record: RecordLog;
  constructor(private config: APIConfig, private system: string, private options: ClientOptions = {}) {
    this.record = options.record ?? noLog;
  }

  async call(history: readonly Message[], options: CallOptions): Promise<ModelResponse> {
    // 先序列化快照。重试期间外部修改不会改变同一次请求。
    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: 64000,
      stream: true,
      system: this.system,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: options.effort },
      tools: [{ ...bashTool, eager_input_streaming: this.options.eagerInputStreaming ?? true }],
      messages: history,
    });
    const callId = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted();
      const started = performance.now();
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException("请求超过 5 分钟", "TimeoutError")), this.config.timeoutMs);
      const signal = AbortSignal.any([options.signal, deadline.signal]);
      let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
      try {
        this.record("request", { callId, attempt, body: JSON.parse(body) });
        const response = await (this.options.fetch ?? fetch)(this.config.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01", accept: "text/event-stream" },
          body,
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 8000).replaceAll(this.config.apiKey, "[认证信息已隐藏]");
          throw new HTTPError(response.status, `HTTP ${response.status}：${detail}`, retryAfter(response.headers.get("retry-after")));
        }
        if (!response.body) throw new ProtocolError("API 没有返回响应体");
        if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new ProtocolError("API 未返回 text/event-stream");
        const assembler = new MessageAssembler(options);
        const parser = new SSEParser(line => {
          this.record("sse", { callId, attempt, line });
          this.options.onRawLine?.(line);
        });
        const streamReader = response.body.getReader();
        reader = streamReader;
        while (true) {
          const { done, value } = await streamReader.read();
          signal.throwIfAborted();
          if (done) break;
          for (const event of parser.feed(value)) assembler.accept(event);
          if (assembler.complete) break;
        }
        for (const event of parser.finish()) assembler.accept(event);
        const result = assembler.finish();
        this.record("response", { callId, attempt, effort: options.effort, durationMs: performance.now() - started, ...result });
        return result;
      } catch (error) {
        // 不把 API key 或包含连接地址的底层错误直接打印到终端。
        const reason = errorMessage(error).replaceAll(this.config.apiKey, "[认证信息已隐藏]").replaceAll(this.config.url, "[API 地址]");
        this.record("request_error", { callId, attempt, durationMs: performance.now() - started, reason });
        if (options.signal.aborted) throw abortError();
        if (attempt >= (this.options.maxRetries ?? 3) || !retryable(error)) throw new Error(reason);
        const delayMs = error instanceof HTTPError && error.retryAfterMs !== undefined ? error.retryAfterMs : 1000 * 2 ** attempt;
        options.onRetry?.(attempt + 1, delayMs, reason);
        // 释放当前连接，再等待重试。工具只在完整响应之后执行。
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; }
        clearTimeout(timer);
        await (this.options.sleep ?? sleep)(delayMs, options.signal);
      } finally {
        clearTimeout(timer);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    }
  }
}
