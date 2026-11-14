import { APIClient } from "./api/client.ts";
import { errorMessage, type Effort } from "./api/types.ts";
import { Agent, systemPrompt } from "./agent/loop.ts";
import { loadConfig } from "./config.ts";
import { SessionLog } from "./log.ts";
import { confirmTool, type PermissionMode } from "./ui/permission.ts";
import { Terminal } from "./ui/terminal.ts";
import { realpathSync } from "node:fs";
import type { ReviewMode } from "./agent/review.ts";

const help = `Axi v1：连续对话，历史仅保留在本次运行中。
/effort medium  设置下一轮为 medium（默认）
/effort high    设置下一轮为 high
/help          显示帮助
/exit          退出
/permissions   查看权限模式
/permissions project  项目内普通文件读取自动（默认）
/permissions strict   所有工具逐次确认
/review auto    有修改或bash执行时，结束前复核一次（默认）
/review off     关闭自动收尾复核；本进程后续任务生效
每次 bash 调用都需输入 y；输入 n 或直接回车拒绝。拒绝理由可留空。
文件修改也逐次确认。自动读取的内容会发送给模型并写入本地日志。
Ctrl+C 中止当前输入、请求或工具。再次输入可继续，已完成修改不会撤销。没有沙箱。
不支持多行粘贴输入。未显示输入提示时，输入会被丢弃。
`;

export async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { process.stdout.write(help); return; }
  const config = loadConfig();
  const cwd = realpathSync(process.cwd());
  const log = new SessionLog(cwd);
  const ui = new Terminal();
  let effort: Effort = "medium";
  let permissionMode: PermissionMode = "project";
  let reviewMode: ReviewMode = "auto";
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
    sessionId: log.id,
    record: log.record,
    permissionMode: () => permissionMode,
    reviewMode: () => reviewMode,
    onReviewStart: reason => { ui.endStream(); ui.write(`\nAxi：收尾复核（${reason === "draft" ? "待复核初稿" : "工作中检查点"}）。本阶段最多10次生成请求，重试计入，权限要求不变。\n`); },
    call: async (history, options) => {
      ui.endStream();
      ui.write("正在处理…\n");
      const start = performance.now();
      const response = await client.call(history, options);
      ui.usage(response, performance.now() - start);
      return response;
    },
    approve: (tool, signal, view) => { ui.endStream(); return confirmTool(tool, cwd, view!, ui.read, ui.write, signal); },
    onToolStart: (tool, view, automatic) => { if (automatic) { ui.endStream(); ui.write(`\n自动读取：${tool.name} ${JSON.stringify(view.path)}\n`); } },
    onToolResult: result => {
      let display = result.content;
      try {
        const data = JSON.parse(display);
        if (data.operation === "read" && typeof data.content === "string") {
          const rows: string[] = data.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
          display = `${JSON.stringify({ ...data, content: undefined })}\n` + rows.map((line, i) => `${data.start_line + i}: ${line}`).join("");
        }
      } catch {}
      ui.write(`\n工具结果${result.is_error ? "（未成功）" : ""}：\n${display}\n`);
    },
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
        if (["/review", "/review auto", "/review off"].includes(text)) {
          if (text !== "/review") reviewMode = text.endsWith("off") ? "off" : "auto";
          ui.write(`收尾复核模式：${reviewMode}。修改和bash仍逐次确认。\n`); continue;
        }
        if (text === "/permissions" || text === "/permissions project" || text === "/permissions strict") {
          if (text !== "/permissions") permissionMode = text.endsWith("strict") ? "strict" : "project";
          ui.write(`权限模式：${permissionMode}。修改和 bash 始终逐次确认；文件工具的路径限制不变。\n`); continue;
        }
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
        if (active.signal.aborted) ui.write(agent.interruptionSummary + "\n");
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
