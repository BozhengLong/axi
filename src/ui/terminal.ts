import { createInterface, type Interface } from "node:readline";
import { abortError, type ModelResponse } from "../api/types.ts";
import type { ReadLine } from "./permission.ts";

// 显示控制符时使用可见转义，避免模型输出覆盖已展示的确认命令。
// 只处理展示副本，原始消息和实际命令不变。
export function visibleText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export class Terminal {
  private rl: Interface;
  private pending?: { resolve: (value: string | null) => void; reject: (error: Error) => void; cleanup: () => void };
  private channel = "";
  closed = false;
  onInterrupt: () => void = () => {};
  onClose: () => void = () => {};
  private color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    this.rl.on("line", line => {
      const pending = this.pending;
      this.pending = undefined;
      pending?.cleanup();
      pending?.resolve(line);
      // 未提出问题时丢弃输入。粘贴的后续行不能预先批准未来命令。
    });
    this.rl.on("SIGINT", () => this.onInterrupt());
    this.rl.on("close", () => {
      this.closed = true;
      const pending = this.pending;
      this.pending = undefined;
      pending?.cleanup();
      pending?.resolve(null);
      this.onClose();
    });
  }

  write = (text: string): void => { process.stdout.write(visibleText(text)); };
  read: ReadLine = (prompt, signal) => {
    this.endStream();
    if (this.closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(abortError());
    // 清除等待模型期间提前键入、但尚未回车的文本。
    if (process.stdin.isTTY) this.rl.write(null, { ctrl: true, name: "u" });
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.pending?.reject === reject) {
          this.pending = undefined;
          this.rl.write(null, { ctrl: true, name: "u" });
          this.write("\n");
          reject(abortError());
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      this.write(prompt);
    });
  };

  stream = (channel: "text" | "thinking", value: string): void => {
    if (!value) return;
    if (channel !== this.channel) {
      this.endStream();
      this.write(channel === "thinking" ? "思考摘要：\n" : "Axi：\n");
      if (channel === "thinking" && this.color) process.stdout.write("\x1b[90m");
      this.channel = channel;
    }
    this.write(value);
  };

  endStream(): void {
    if (this.channel) {
      if (this.color) process.stdout.write("\x1b[0m");
      this.write("\n");
      this.channel = "";
    }
  }

  usage(response: ModelResponse, ms: number): void {
    this.endStream();
    const u = response.usage;
    this.write(`↑ 输入 ${u.input_tokens ?? "未知"}（缓存读 ${u.cache_read_input_tokens ?? 0} / 写 ${u.cache_creation_input_tokens ?? 0}） ↓ 输出 ${u.output_tokens ?? "未知"}  ⏱ ${(ms / 1000).toFixed(1)}s\n`);
  }

  close(): void { this.endStream(); this.rl.close(); }
}
