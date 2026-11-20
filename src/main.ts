import { APIClient, RetryWindowError } from "./api/client.ts";
import { errorMessage, type Effort } from "./api/types.ts";
import { Agent, systemPrompt } from "./agent/loop.ts";
import { loadProfile, profileNameValid, shellEnvironment } from "./profiles.ts";
import { runSetup } from "./setup.ts";
import { buildCommit, version } from "./version.ts";
import { redact } from "./api/wire.ts";
import { runBash } from "./tools/bash.ts";
import { SessionLog } from "./log.ts";
import { confirmTool, type PermissionMode } from "./ui/permission.ts";
import { Terminal } from "./ui/terminal.ts";
import { realpathSync } from "node:fs";
import type { ReviewMode } from "./agent/review.ts";

const help = `Axi：连续对话，历史仅保留在本次运行中。
axi setup [--profile NAME]   配置提供商、模型和认证
axi [--profile NAME]         启动模型会话
axi --version                显示版本与构建提交
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
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(help); return; }
  if (args.length === 1 && args[0] === "--version") { process.stdout.write(`axi ${version} (${buildCommit})\n`); return; }
  const setup = args[0] === "setup";
  if (setup) args.shift();
  const name = args[1];
  if (args.length && (args.length !== 2 || args[0] !== "--profile" || !profileNameValid(name))) throw new Error("参数无效。请运行 axi --help。");

  if (setup && !process.stdin.isTTY) throw new Error("axi setup 需要交互终端。");
  const ui = new Terminal(true);
  const preparing = new AbortController();
  const cancelPreparation = () => preparing.abort();
  ui.onInterrupt = cancelPreparation;
  process.on("SIGINT", cancelPreparation);
  let config;
  try {
    if (setup) await runSetup(ui, name, preparing.signal);
    else config = await loadProfile(name, prompt => ui.readSecret(prompt, preparing.signal));
  } catch (error) {
    if (!preparing.signal.aborted && (error as Error).name !== "AbortError") {
      ui.close();
      throw error;
    }
    ui.write("已取消。\n");
  } finally {
    process.removeListener("SIGINT", cancelPreparation);
  }
  if (!config) { ui.close(); return; }
  const cwd = realpathSync(process.cwd());
  let log: SessionLog;
  try { log = new SessionLog(cwd); } catch (error) { ui.close(); throw error; }
  ui.filterOutput = value => redact(value, config.apiKey);
  const record = (kind: string, data: unknown) => log.record(kind, JSON.parse(JSON.stringify(data,
    (_key, value) => typeof value === "string" ? redact(value, config.apiKey) : value)));
  let effort: Effort = "medium";
  let permissionMode: PermissionMode = "project";
  let reviewMode: ReviewMode = "auto";
  let active: AbortController | undefined;
  const interrupt = () => active?.abort();
  ui.onInterrupt = interrupt;
  ui.onClose = interrupt;
  process.on("SIGINT", interrupt);
  const client = new APIClient(config, systemPrompt(cwd), {
    record,
    onRawLine: process.env.AXI_DEBUG === "sse" ? line => ui.write(`[SSE ${new Date().toISOString()}] ${line}\n`) : undefined,
  });
  const agent = new Agent({
    cwd,
    sessionId: log.id,
    record,
    execute: (input, cwd, signal) => runBash(input, cwd, signal, shellEnvironment(config)),
    permissionMode: () => permissionMode,
    reviewMode: () => reviewMode,
    onReviewStart: () => { ui.endStream(); ui.write("\nAxi：收尾复核（待复核初稿）。不设请求次数上限，权限要求不变。\n"); },
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
  if (config.profile) { record("profile_selected", { profile: config.profile, provider: config.provider, model: config.model, protocol: config.protocol }); ui.write(`模型配置：${config.profile}（${config.model}）\n`); }
  ui.write(`${help}\n任务请求次数：不限。连续故障恢复窗口：${config.retryWindowMs! / 1000}秒。\n工作目录：${cwd}\n日志：${log.path}\n`);
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
          onRetry: (attempt, ms, reason, notice) => {
            ui.endStream();
            ui.write(notice.willRetry
              ? `本次响应未写入历史。将在 ${(ms / 1000).toFixed(1)}s 后重试（第${attempt}次，窗口剩余${(notice.remainingMs / 1000).toFixed(1)}s）：${reason}\n`
              : `本次响应未写入历史。所需等待超过恢复窗口，将在剩余${(ms / 1000).toFixed(1)}s后停止；可按Ctrl+C取消：${reason}\n`);
          },
        });
        ui.endStream();
        if (notice) ui.write(`${notice}\n`);
      } catch (error) {
        ui.endStream();
        ui.write(active.signal.aborted ? "已中止。\n" : `错误：${errorMessage(error)}\n`);
        if (active.signal.aborted || error instanceof RetryWindowError) ui.write(agent.interruptionSummary + "\n已有文件和Trace保留；没有自动重放任务。\n");
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
