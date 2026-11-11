import { fatalFaults } from "./container/faults.ts";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { control, execArgs, execute, freeze, save, snapshot, type Batch, type Runtime, type Snapshot } from "./core.ts";
import { visibleText } from "../../src/ui/terminal.ts";
import { parseBashInput } from "../../src/tools/bash.ts";
import { IOTrace } from "./trace.ts";

const strip = (value: string) => value.replaceAll("\x1b[1G\x1b[0J> \x1b[3G", "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
export type Execution = { status: string; error?: string; wallMs: number; turns: string[]; snapshots: Snapshot[]; proxy: any; stdoutPath: string; activeMs?: number; roundActiveMs?: number[] };
export type RunOptions = { maxMs?: number; roundMaxMs?: number; axiEntry?: string; interruptMarker?: string; onTurn?: (index: number) => Promise<void>; onRound?: (index: number) => Promise<{ snapshot: Snapshot; nextPrompt?: string }> };

export async function runAxi(batch: Batch, runtime: Runtime, prompts: string[], options: RunOptions = {}): Promise<Execution> {
  const entry = options.axiEntry ?? "/opt/axi/src/main.ts";
  const started = performance.now(), stdoutPath = join(runtime.directory, "terminal.txt");
  let excludedMs = 0, roundStarted = started; const roundActiveMs: number[] = [];
  const turns: string[] = [], snapshots: Snapshot[] = [];
  let output = "", sent = 0, handled = 0, lastState: any, stage = "ready", actionOffset = -1, responsesAtTurn = 0, interrupted = false;
  let terminal: Bun.Terminal;
  const decoder = new TextDecoder();
  const trace = new IOTrace(runtime.directory, "axi", ["bun", entry]);
  const input = (value: string) => { trace.bytes("stdin", value); terminal.write(value); };
  const child = Bun.spawn(execArgs(runtime, ["bun", entry], true), {
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: { cols: 180, rows: 50, data(term, bytes) {
      terminal = term;
      trace.bytes("terminal", bytes);
      const text = decoder.decode(bytes, { stream: true }); output += text;
      appendFileSync(stdoutPath, text, { mode: 0o600 });
    } },
  });
  terminal = child.terminal!;
  let status = "completed", error: string | undefined;
  try {
    while (performance.now() - started - excludedMs < (options.maxMs ?? 900000)) {
      if (performance.now() - roundStarted > (options.roundMaxMs ?? options.maxMs ?? 900000)) throw new Error("round deadline");
      if (output.length > 200 * 1024 * 1024 || trace.truncated) throw new Error("terminal output limit");
      const text = strip(output);
      lastState = await control(batch, "state", { id: runtime.id });
      if (fatalFaults(lastState.faults).length) throw new Error(`relay: ${fatalFaults(lastState.faults).join(",")}`);
      if (options.interruptMarker && !interrupted && handled > 0 && stage === "running") {
        const exists = await execute(runtime, ["test", "-f", options.interruptMarker], undefined, true);
        if (exists.exitCode === 0) { input("\x03"); interrupted = true; }
      }
      if (text.length > actionOffset && stage === "reason" && text.endsWith("拒绝理由（选填，回车跳过）：")) {
        actionOffset = text.length; input("保留原文件 keep.txt，不要修改或删除它。请把新内容另存为 copy.txt。\n"); stage = "running";
      } else if (text.length > actionOffset && stage === "running" && text.endsWith("执行这次调用？[y/N] ")) {
        const tool = lastState.tools.find((t: any) => {
          if (t.approved || t.name !== "bash") return false;
          try { parseBashInput(t.input); } catch { return false; }
          return text.endsWith(`工作目录：/task\n完整命令：\n${visibleText(t.input.command)}\n执行这次调用？[y/N] `);
        });
        if (!tool || tool.name !== "bash") throw new Error("confirmation has no completed matching tool");
        if (!tool.messageComplete) throw new Error("axi requested confirmation before complete response");
        const expected = `工作目录：/task\n完整命令：\n${visibleText(tool.input.command)}\n执行这次调用？[y/N] `;
        if (!text.endsWith(expected)) throw new Error("confirmation text differs from tool input");
        const permission = await control(batch, "permission", { id: runtime.id, tool_name: tool.name, input: tool.input, tool_use_id: tool.id });
        handled++; actionOffset = text.length;
        if (permission.behavior === "allow") { input("y\n"); }
        else { input("n\n"); stage = "reason"; }
      }
      if (text.length > actionOffset && text.endsWith("你 [medium] > ") && ["ready", "running"].includes(stage)) {
        if (sent > 0) {
          const last = lastState.responses.at(-1);
          if (lastState.responses.length <= responsesAtTurn && !interrupted) throw new Error("axi request failed before complete response");
          // 工具执行后请求失败也会回到输入提示。不能把上一个 tool_use 当作最终交付。
          if (!interrupted && last?.stopReason === "tool_use") throw new Error(lastState.faults.includes("request_budget") ? "request_budget: axi ended with pending tool cycle" : "axi request failed after tool result");
          turns.push((last?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
          roundActiveMs.push(performance.now() - roundStarted);
          if (options.onRound) {
            const paused = performance.now();
            try {
              const next = await options.onRound(sent - 1);
              snapshots.push(next.snapshot);
              if (next.nextPrompt !== undefined) prompts[sent] = next.nextPrompt;
            } finally { excludedMs += performance.now() - paused; }
          } else {
            snapshots.push(await snapshot(runtime));
            await options.onTurn?.(sent - 1);
          }
          roundStarted = performance.now();
        }
        if (sent === prompts.length) { input("/exit\n"); break; }
        actionOffset = text.length; responsesAtTurn = lastState.responses.length;
        input(prompts[sent++]! + "\n"); stage = "running";
      }
      if (child.exitCode !== null) throw new Error(`axi exited ${child.exitCode} before completing turns`);
      await Bun.sleep(40);
    }
    if (turns.length !== prompts.length) throw new Error("task deadline or incomplete turns");
    await Promise.race([child.exited, Bun.sleep(5000)]);
  } catch (e) { error = String(e); status = error.includes("request_budget") ? "budget_exhausted" : error.includes("deadline") ? "task_timeout" : /axi (exited|request failed)/.test(error) ? "product_error" : "runner_error"; trace.event("error", { error }); input("\x03"); }
  finally {
    // 外部回收整个容器中的用户进程；PID 1 保持到收取快照完成。
    await execute(runtime, ["pkill", "-KILL", "-f", entry], undefined, true).catch(() => {});
    child.kill("SIGKILL"); await child.exited; terminal.close();
    trace.event("finish", { status, error, exitCode: child.exitCode, stderr: "merged_in_terminal" });
  }
  const proxy = await control(batch, "state", { id: runtime.id });
  if (proxy.faults.includes("request_budget")) status = "budget_exhausted";
  await freeze(runtime);
  const result = { status, error, wallMs: performance.now() - started, activeMs: performance.now() - started - excludedMs, roundActiveMs, turns, snapshots, proxy, stdoutPath };
  save(join(runtime.directory, "execution.json"), result); return result;
}

export async function runClaude(batch: Batch, runtime: Runtime, prompts: string[], options: RunOptions = {}): Promise<Execution> {
  const started = performance.now(), stdoutPath = join(runtime.directory, "claude.jsonl");
  let excludedMs = 0, roundStarted = started; const roundActiveMs: number[] = [];
  const mcp = { mcpServers: { permissions: { command: "bun", args: ["/opt/eval/permission.ts"] } } };
  const settings = { permissions: { ask: ["Bash", "Write", "Edit"], deny: ["Agent", "WebFetch", "WebSearch"] }, autoMemoryEnabled: false };
  const args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--debug-file", "/home/eval/claude-debug.log", "--model", "claude-opus-5-5", "--effort", "medium", "--setting-sources", "", "--settings", JSON.stringify(settings), "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--permission-mode", "manual", "--permission-prompt-tool", "mcp__permissions__approve", "--disable-slash-commands", "--tools", "Bash,Read,Write,Edit,Glob,Grep"];
  const trace = new IOTrace(runtime.directory, "claude", args);
  const child = Bun.spawn(execArgs(runtime, args), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const turns: string[] = [], snapshots: Snapshot[] = [];
  let sent = 0, buffer = "", status = "completed", error: string | undefined, interrupted = false, polling = false;
  const input = (value: string) => { trace.bytes("stdin", value); child.stdin.write(value); child.stdin.flush(); };
  const send = () => input(JSON.stringify({ type: "user", message: { role: "user", content: prompts[sent++] }, parent_tool_use_id: null, session_id: "" }) + "\n");
  let timer: ReturnType<typeof setTimeout>;
  const armTimer = () => {
    clearTimeout(timer!);
    const remaining = Math.min(options.roundMaxMs ?? options.maxMs ?? 900000, (options.maxMs ?? 900000) - (performance.now() - started - excludedMs));
    timer = setTimeout(() => { status = "task_timeout"; child.kill("SIGKILL"); }, Math.max(0, remaining));
  };
  armTimer();
  const stderrPath = join(runtime.directory, "stderr.txt"); writeFileSync(stderrPath, "", { mode: 0o600 });
  const stderr = (async () => {
    const chunks: Uint8Array[] = [];
    try { for await (const bytes of child.stderr) {
      trace.bytes("stderr", bytes); appendFileSync(stderrPath, bytes); chunks.push(bytes);
      if (trace.truncated) { child.kill("SIGKILL"); break; }
    } } catch (e) { trace.event("stderr_read_error", { error: String(e) }); }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const interruptPoll = options.interruptMarker ? setInterval(async () => {
    if (polling || interrupted) return;
    polling = true;
    try {
      const found = await execute(runtime, ["test", "-f", options.interruptMarker!], undefined, true);
      if (found.exitCode === 0) { interrupted = true; input(JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } }) + "\n"); }
    } finally { polling = false; }
  }, 150) : undefined;
  const decoder = new TextDecoder();
  try {
    send();
    for await (const bytes of child.stdout) {
      trace.bytes("stdout", bytes);
      const text = decoder.decode(bytes, { stream: true });
      appendFileSync(stdoutPath, text, { mode: 0o600 }); buffer += text;
      if (buffer.length > 200 * 1024 * 1024 || trace.truncated) throw new Error("claude output limit");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === "result") {
          if ((e.is_error || e.subtype !== "success") && !(interrupted && sent === 1)) throw new Error(`claude result ${e.subtype}: ${JSON.stringify(e.errors ?? e.result)}`);
          turns.push(e.result ?? ""); roundActiveMs.push(performance.now() - roundStarted);
          if (options.onRound) {
            clearTimeout(timer!);
            const paused = performance.now();
            try {
              const next = await options.onRound(sent - 1);
              snapshots.push(next.snapshot);
              if (next.nextPrompt !== undefined) prompts[sent] = next.nextPrompt;
            } finally { excludedMs += performance.now() - paused; }
          } else {
            snapshots.push(await snapshot(runtime)); await options.onTurn?.(sent - 1);
          }
          roundStarted = performance.now();
          if (sent === prompts.length) { child.stdin.end(); armTimer(); } else { armTimer(); send(); }
        }
      }
    }
    const exitCode = await child.exited;
    if (exitCode !== 0 || turns.length !== prompts.length) throw new Error(`claude exit ${exitCode}; completed ${turns.length}/${prompts.length}; ${(await stderr).slice(0, 1500)}`);
  } catch (e) { if (status !== "task_timeout") status = "product_or_runner_error"; error = String(e); trace.event("error", { error }); }
  finally {
    clearTimeout(timer!); if (interruptPoll) clearInterval(interruptPoll); child.kill("SIGKILL");
    await child.exited; await stderr;
    trace.event("finish", { status, error, exitCode: child.exitCode });
  }
  const proxy = await control(batch, "state", { id: runtime.id });
  if (proxy.faults.includes("request_budget")) status = "budget_exhausted";
  await freeze(runtime);
  const result = { status, error, wallMs: performance.now() - started, activeMs: performance.now() - started - excludedMs, roundActiveMs, turns, snapshots, proxy, stdoutPath };
  save(join(runtime.directory, "execution.json"), result); return result;
}
