import { APIClient } from "./api/client.ts";
import { errorMessage, type Effort } from "./api/types.ts";
import { Agent, systemPrompt } from "./agent/loop.ts";
import { loadConfig } from "./config.ts";
import { SessionLog } from "./log.ts";
import { confirmCommand } from "./ui/permission.ts";
import { Terminal } from "./ui/terminal.ts";

const help = `Axi v0：连续对话，历史仅保留在本次运行中。
/effort medium  设置下一轮为 medium（默认）
/effort high    设置下一轮为 high
/help          显示帮助
/exit          退出
每次 bash 调用都需输入 y；输入 n 或直接回车拒绝。拒绝理由可留空。
Ctrl+C 中止当前输入、请求或命令。再次输入可继续。v0 没有沙箱。
不支持多行粘贴输入。未显示输入提示时，输入会被丢弃。
`;

export async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { process.stdout.write(help); return; }
  const config = loadConfig();
  const cwd = process.cwd();
  const log = new SessionLog(cwd);
  const ui = new Terminal();
  let effort: Effort = "medium";
  let active: AbortController | undefined;
  const interrupt = () => active?.abort();
  ui.onInterrupt = interrupt;
  ui.onClose = interrupt;
  process.on("SIGINT", interrupt);
  const client = new APIClient(config, systemPrompt(cwd), {
    record: log.record,
    onRawLine: process.env.AXI_DEBUG === "sse" ? line => ui.write(`[SSE ${new Date().toISOString()}] ${line}\n`) : undefined,
  });
  const agent = new Agent({
    cwd,
    record: log.record,
    call: async (history, options) => {
      ui.endStream();
      ui.write("正在处理…\n");
      const start = performance.now();
      const response = await client.call(history, options);
      ui.usage(response, performance.now() - start);
      return response;
    },
    approve: (tool, signal) => { ui.endStream(); return confirmCommand(tool.input.command as string, cwd, ui.read, ui.write, signal); },
    onToolResult: result => ui.write(`\n工具结果${result.is_error ? "（未成功）" : ""}：\n${result.content}\n`),
  });
  ui.write(`${help}\n工作目录：${cwd}\n日志：${log.path}\n`);
  try {
    while (!ui.closed) {
      active = new AbortController();
      try {
        const input = await ui.read(`\n你 [${effort}] > `, active.signal);
        if (input === null || input.trim() === "/exit") break;
        const text = input.trim();
        if (!text) continue;
        if (text === "/help") { ui.write(help); continue; }
        if (text === "/effort medium" || text === "/effort high") {
          effort = text.endsWith("high") ? "high" : "medium";
          ui.write(`下一轮使用 ${effort}。\n`);
          continue;
        }
        if (text.startsWith("/")) { ui.write("未知命令。输入 /help 查看帮助。\n"); continue; }
        const notice = await agent.run(input, {
          effort,
          signal: active.signal,
          onText: text => ui.stream("text", text),
          onThinking: text => ui.stream("thinking", text),
          onRetry: (attempt, ms, reason) => {
            ui.endStream();
            ui.write(`本次响应未写入历史。将在 ${(ms / 1000).toFixed(1)}s 后重试（${attempt}/3）：${reason}\n`);
          },
        });
        ui.endStream();
        if (notice) ui.write(`${notice}\n`);
      } catch (error) {
        ui.endStream();
        ui.write(active.signal.aborted ? "已中止。\n" : `错误：${errorMessage(error)}\n`);
      } finally { active = undefined; }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    ui.close();
    log.close();
  }
}

if (import.meta.main) {
  main().catch(error => { process.stderr.write(`启动失败：${errorMessage(error)}\n`); process.exitCode = 1; });
}
