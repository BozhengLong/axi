import { DEFAULT_RETRY_WINDOW_MS, type APIConfig } from "../config.ts";
import { SSEParser } from "./sse.ts";
import { MessageAssembler, ProtocolError, StreamAPIError } from "./stream.ts";
import { abortError, errorMessage, noLog, type Effort, type Message, type ModelResponse, type RecordLog, type StreamCallbacks } from "./types.ts";
import { toolDefinitions } from "../tools/registry.ts";
import type { GenerationCounter } from "../agent/review.ts";

export class HTTPError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) { super(message); }
}

export class RetryWindowError extends Error {
  constructor(readonly windowMs: number, readonly attempts: number, reason: string) {
    super(`连续故障恢复窗口（${windowMs / 1000}秒）已到，已尝试${attempts}次，本轮未完成。最后原因：${reason}`);
  }
}

export interface RetryNotice { windowMs: number; remainingMs: number; willRetry: boolean }

export interface CallOptions extends StreamCallbacks {
  signal: AbortSignal;
  effort: Effort;
  onRetry?: (attempt: number, delayMs: number, reason: string, notice: RetryNotice) => void;
  budget?: GenerationCounter;
}
export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  record?: RecordLog;
  maxRetries?: number;
  now?: () => number;
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
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function retryable(error: unknown): boolean {
  if (error instanceof HTTPError) return error.status === 429 || error.status >= 500;
  if (error instanceof StreamAPIError) return error.normalized?.retryable ?? ["overloaded_error", "rate_limit_error", "api_error", "connection_error"].includes(error.errorType);
  if (error instanceof TypeError || (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))) return true;
  // Bun 1.3.14 的连接拒绝是普通 Error，不能只判断 TypeError。
  // 仅识别明确的网络错误码，避免重试文件权限等本地错误。
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && ["ConnectionRefused", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"].includes(code);
}

export class APIClient {
  private record: RecordLog;
  constructor(private config: APIConfig, private system: string, private options: ClientOptions = {}) {
    const record = options.record ?? noLog;
    this.record = (kind, data) => {
      try { record(kind, data); }
      catch { throw new Error("日志写入失败，已停止本次请求。"); }
    };
    const windowMs = config.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 2_147_483_647) throw new Error("故障恢复窗口必须是1至2147483647的整数毫秒");
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647) throw new Error("请求超时必须是有效的正数毫秒");
    if (options.maxRetries !== undefined && (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0)) throw new Error("maxRetries必须是非负整数");
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
      tools: toolDefinitions.map(tool => ({ ...tool, eager_input_streaming: this.options.eagerInputStreaming ?? true })),
      messages: history,
    });
    const callId = crypto.randomUUID();
    const now = this.options.now ?? (() => performance.now());
    const windowMs = this.config.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
    const callStarted = now(), expires = callStarted + windowMs;
    let attempts = 0, lastReason = "未取得完整响应";
    const exhausted = (): never => {
      this.record("retry_exhausted", { callId, attempts, windowMs, elapsedMs: now() - callStarted, reason: lastReason });
      throw new RetryWindowError(windowMs, attempts, lastReason);
    };
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted();
      const remainingMs = expires - now();
      if (remainingMs <= 0) exhausted();
      // 保留实际尝试计数，但不根据任务累计次数停止。
      options.budget?.consume();
      attempts++;
      const started = performance.now();
      const deadline = new AbortController();
      const timeoutMs = Math.min(this.config.timeoutMs, remainingMs);
      const timer = setTimeout(() => deadline.abort(new DOMException("模型请求等待超时", "TimeoutError")), timeoutMs);
      const signal = AbortSignal.any([options.signal, deadline.signal]);
      let response: Response | undefined;
      let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
      try {
        this.record("request", { callId, attempt, budget: options.budget?.snapshot(), recovery: { windowMs, remainingMs, elapsedMs: now() - callStarted }, body: JSON.parse(body) });
        options.signal.throwIfAborted();
        if (now() >= expires) exhausted();
        response = await (this.options.fetch ?? fetch)(this.config.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01", accept: "text/event-stream" },
          body,
          signal,
        });
        signal.throwIfAborted();
        if (now() >= expires) exhausted();
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
        signal.throwIfAborted();
        if (now() >= expires) exhausted();
        this.record("response", { callId, attempt, effort: options.effort, durationMs: performance.now() - started, ...result });
        return result;
      } catch (error) {
        // 不把 API key 或包含连接地址的底层错误直接打印到终端。
        const sanitize = (text: string) => text.replaceAll(this.config.apiKey, "[认证信息已隐藏]").replaceAll(this.config.url, "[API 地址]");
        const reason = sanitize(errorMessage(error));
        const canRetry = retryable(error);
        const left = expires - now();
        const canRecover = !options.signal.aborted && (this.options.maxRetries === undefined || attempt < this.options.maxRetries) && canRetry && left > 0;
        const requestedDelayMs = error instanceof HTTPError && error.retryAfterMs !== undefined ? Math.max(1, error.retryAfterMs) : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        const willRetry = canRecover && requestedDelayMs < left;
        const details = error instanceof StreamAPIError ? JSON.parse(sanitize(JSON.stringify({ normalizedError: error.normalized, rawError: error.rawError, errorType: error.errorType }))) : {};
        this.record("request_error", { callId, attempt, durationMs: performance.now() - started, reason, ...details, retryable: canRetry, willRetry });
        if (options.signal.aborted) throw abortError();
        if (error instanceof RetryWindowError) throw error;
        lastReason = reason;
        if (left <= 0) exhausted();
        if (!canRecover) throw new Error(reason);
        const delayMs = Math.min(requestedDelayMs, left);
        const notice = { windowMs, remainingMs: left, willRetry: requestedDelayMs < left };
        this.record("retry_scheduled", { callId, attempt: attempt + 1, delayMs, requestedDelayMs, reason, ...notice });
        options.onRetry?.(attempt + 1, delayMs, reason, notice);
        // 释放当前连接，再等待重试。工具只在完整响应之后执行。
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; }
        clearTimeout(timer);
        const waitMs = Math.min(delayMs, expires - now());
        if (waitMs <= 0) exhausted();
        await (this.options.sleep ?? sleep)(waitMs, options.signal);
        options.signal.throwIfAborted();
        if (!notice.willRetry || now() >= expires) exhausted();
      } finally {
        clearTimeout(timer);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else if (response?.body) await response.body.cancel().catch(() => {});
      }
    }
  }
}
