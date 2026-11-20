import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { abortError, type ModelResponse } from "../api/types.ts";
import type { ReadLine } from "./permission.ts";
import { visibleText } from "../text.ts";
export { visibleText } from "../text.ts";

// 显示控制符时使用可见转义，避免模型输出覆盖已展示的确认命令。
// 只处理展示副本，原始消息和实际命令不变。
export class Terminal {
  private rl: Interface;
  private pending?: { resolve: (value: string | null) => void; reject: (error: Error) => void; cleanup: () => void };
  private channel = "";
  closed = false;
  private masking = false;
  filterOutput = (value: string) => value;
  onInterrupt: () => void = () => {};
  onClose: () => void = () => {};
  private color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined;

  constructor(secretInput = false) {
    const output = secretInput ? new Writable({
      write: (chunk, encoding, done) => {
        if (this.masking) done();
        else process.stdout.write(chunk, encoding, done);
      },
    }) : process.stdout;
    if (secretInput) Object.defineProperty(output, "columns", { get: () => process.stdout.columns });
    this.rl = createInterface({
      input: process.stdin, output, terminal: !!process.stdin.isTTY,
      ...(secretInput ? { historySize: 0 } : {}),
    });
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

  write = (text: string): void => { process.stdout.write(visibleText(this.filterOutput(text))); };
  read: ReadLine = (prompt, signal) => {
    this.endStream();
    if (this.closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(abortError());
    this.clearInput();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.pending?.reject === reject) {
          this.pending = undefined;
          this.clearInput();
          this.write("\n");
          reject(abortError());
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      this.write(prompt);
    });
  };

  readSecret: ReadLine = async (prompt, signal) => {
    if (!process.stdin.isTTY) throw new Error("遮掩输入需要交互终端。请使用环境变量认证。");
    this.masking = true;
    try { return await this.read(prompt, signal); }
    finally { this.masking = false; this.write("\n"); }
  };

  private clearInput(): void {
    if (!process.stdin.isTTY) return;
    // Ctrl+U 只删除光标左侧。先移到末尾，防止提前键入的 y 留到下一次确认。
    this.rl.write(null, { ctrl: true, name: "e" });
    this.rl.write(null, { ctrl: true, name: "u" });
  }

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
