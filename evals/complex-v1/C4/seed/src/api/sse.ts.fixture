export interface SSEEvent {
  event: string;
  data: string;
}

// SSE 的边界是空行，不是网络 chunk。CRLF 还可能跨两个 chunk。
export class SSEParser {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private line = "";
  private afterCR = false;
  private event = "";
  private data: string[] = [];
  private eventSize = 0;

  constructor(private onLine: (line: string) => void = () => {}) {}

  feed(bytes: Uint8Array): SSEEvent[] {
    return this.consume(this.decoder.decode(bytes, { stream: true }));
  }

  finish(): SSEEvent[] {
    const events = this.consume(this.decoder.decode());
    // 没有空行结束的尾部事件不能派发，但仍保留在原始日志中。
    if (this.line) this.onLine(this.line);
    this.line = "";
    this.data = [];
    return events;
  }

  private consume(text: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    for (const char of text) {
      if (this.afterCR && char === "\n") {
        this.afterCR = false;
        continue;
      }
      this.afterCR = char === "\r";
      if (char === "\r" || char === "\n") {
        this.processLine(events);
        this.line = "";
      } else {
        this.line += char;
        if (this.line.length + this.eventSize > 8 * 1024 * 1024) {
          throw new Error("SSE 事件超过 8 MiB 限制");
        }
      }
    }
    return events;
  }

  private processLine(events: SSEEvent[]): void {
    this.onLine(this.line);
    if (this.line === "") {
      if (this.data.length) events.push({ event: this.event || "message", data: this.data.join("\n") });
      this.data = [];
      this.event = "";
      this.eventSize = 0;
      return;
    }
    if (this.line.startsWith(":")) return;
    const colon = this.line.indexOf(":");
    const field = colon < 0 ? this.line : this.line.slice(0, colon);
    let value = colon < 0 ? "" : this.line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    if (field === "data") {
      this.data.push(value);
      this.eventSize += value.length + 1;
    }
  }
}
