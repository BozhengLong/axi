import { isObject, type JsonObject } from "../api/types.ts";

export const bashTool = {
  name: "bash",
  description: "执行一段 bash 命令。每次调用都需用户确认。工作目录固定，每次使用新 shell，cd 和环境变量不会沿用。stdin 关闭。默认超时 120 秒，最多 600 秒。输出保留头尾。",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 600000 } },
    required: ["command"],
    additionalProperties: false,
  },
};

export interface BashInput { command: string; timeoutMs: number }
export interface BashResult { content: string; isError: boolean; exitCode: number | null; outcome: "completed" | "timeout" | "cancelled" | "failed" }

export function parseBashInput(input: JsonObject): BashInput {
  if (!isObject(input) || typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0")) throw new Error("command 必须是非空字符串，且不能包含 NUL");
  if (Object.keys(input).some(key => !["command", "timeout_ms"].includes(key))) throw new Error("bash 参数只能包含 command 和 timeout_ms");
  const timeoutMs = input.timeout_ms ?? 120000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error("timeout_ms 必须是 1 至 600000 的整数");
  return { command: input.command, timeoutMs };
}

// 一边读取一边截断。按 Unicode 码点计数，避免截出半个表情字符。
export class BoundedOutput {
  private head: string[] = [];
  private tail: string[] = [];
  private total = 0;
  constructor(private limit = 30000) {}
  append(text: string): void {
    const chars = Array.from(text);
    this.total += chars.length;
    const headLimit = Math.ceil(this.limit / 2);
    const take = Math.min(headLimit - this.head.length, chars.length);
    this.head.push(...chars.slice(0, take));
    const rest = chars.slice(take);
    this.tail = this.tail.concat(rest).slice(-Math.floor(this.limit / 2));
  }
  toString(): string {
    const omitted = this.total - this.head.length - this.tail.length;
    return this.head.join("") + (omitted > 0 ? `\n[省略 ${omitted} 字符]\n` : "") + this.tail.join("");
  }
}

export async function runBash(input: BashInput, cwd: string, signal: AbortSignal): Promise<BashResult> {
  if (signal.aborted) return { content: "用户已中止，命令未执行。", isError: true, exitCode: null, outcome: "cancelled" };
  const output = new BoundedOutput();
  const state: { outcome: BashResult["outcome"] } = { outcome: "completed" };
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["bash", "-c", input.command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (error) {
    return { content: `命令无法启动：${error instanceof Error ? error.message : String(error)}`, isError: true, exitCode: null, outcome: "failed" };
  }
  const killGroup = () => {
    // 子 shell 可以再启动进程。仅杀 shell 会留下仍在运行的子进程。
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  };
  const abort = () => { state.outcome = "cancelled"; killGroup(); };
  const timer = setTimeout(() => { state.outcome = "timeout"; killGroup(); }, input.timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.append(decoder.decode(chunk, { stream: true }));
    output.append(decoder.decode());
  }
  let exitCode: number | null = null;
  try {
    const exited = child.exited.then(code => { killGroup(); return code; });
    const [code] = await Promise.all([exited, drain(child.stdout as ReadableStream<Uint8Array>), drain(child.stderr as ReadableStream<Uint8Array>)]);
    exitCode = code;
  } catch (error) {
    state.outcome = "failed";
    output.append(`\n读取命令输出失败：${String(error)}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // v0 不提供后台任务；调用结束时回收同一进程组内的残留进程。
    killGroup();
    await child.exited;
  }
  const { outcome } = state;
  const status = outcome === "timeout" ? `命令超过 ${input.timeoutMs} ms，已终止。` : outcome === "cancelled" ? "用户已中止，进程已终止。已发生的文件修改不会自动撤销。" : "";
  return { content: `${status ? status + "\n" : ""}退出码：${exitCode ?? "未知"}\n${output.toString() || "（无输出）"}`, isError: outcome !== "completed" || exitCode !== 0, exitCode, outcome };
}
