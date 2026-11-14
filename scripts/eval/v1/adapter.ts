import { fatalFaults } from "../container/faults.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { control, execArgs, execute, freeze, save, snapshot, type Batch, type Runtime, type Snapshot } from "../core.ts";
import { IOTrace } from "../trace.ts";
import type { Execution, RunOptions } from "../adapters.ts";
import { verifyPermission } from "./preview.ts";
import type { ToolUse } from "../../../src/api/types.ts";

export const normalizeTerminal = (value: string) => value.replaceAll("\x1b[1G\x1b[0J> \x1b[3G", "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "");
export type V1Options = RunOptions & { reviewMode?: "auto" | "off"; observeReview?: boolean; onReviewCheckpoint?: (state: any) => Promise<void>; interruptOnReview?: boolean; beforeInspect?: (runtime: Runtime) => Promise<void>; beforeApprove?: (tool: ToolUse, runtime: Runtime) => Promise<void> };

export async function runAxiV1(batch: Batch, runtime: Runtime, prompts: string[], options: V1Options = {}): Promise<Execution> {
  const entry = "/opt/axi/src/main.ts", started = performance.now(), stdoutPath = join(runtime.directory, "terminal.txt");
  const trace = new IOTrace(runtime.directory, "axi", ["bun", entry]);
  let output = "", sent = 0, excludedMs = 0, roundStarted = started, responsesAtTurn = 0, actionOffset = 0, lastPermission = -1;
  let configuredReview = false, checkpointTurn = 0, requestsAtTurn = 0;
  const reviewAware = options.observeReview ?? !!process.env.AXI_REVIEW_STUDY;
  const observe = async () => JSON.parse((await execute(runtime, ["bun", "/opt/eval/review-observe.ts"])).stdout);
  let stage = "ready", interrupted = false, status = "completed", error: string | undefined, state: any = {};
  const turns: string[] = [], snapshots: Snapshot[] = [], roundActiveMs: number[] = [], decoder = new TextDecoder();
  const child = Bun.spawn(execArgs(runtime, ["bun", entry], true), { env: { ...process.env, TERM: "xterm-256color" }, terminal: { cols: 180, rows: 50, data(_term, bytes) {
    trace.bytes("terminal", bytes); const text = decoder.decode(bytes, { stream: true }); output += text; appendFileSync(stdoutPath, text, { mode: 0o600 });
  } } });
  const terminal = child.terminal!, input = (value: string) => { trace.bytes("stdin", value); terminal.write(value); };
  try {
    while (performance.now() - started - excludedMs < (options.maxMs ?? 900000)) {
      if (performance.now() - roundStarted > (options.roundMaxMs ?? options.maxMs ?? 900000)) throw new Error("round deadline");
      if (output.length > 200 * 1024 * 1024 || trace.truncated) throw new Error("terminal output limit");
      const text = normalizeTerminal(output);
      state = await control(batch, "state", { id: runtime.id });
      if (fatalFaults(state.faults).length) throw new Error(`relay: ${fatalFaults(state.faults).join(",")}`);
      if (reviewAware && sent > checkpointTurn && text.includes("Axi：收尾复核（")) {
        const native = await observe();
        if (native.review && native.start?.input === prompts[sent - 1]) {
          // 复核阶段所有修改仍须经过下面的授权分支。先保存检查点，再允许任何复核写入。
          if (native.permissions.some((p: any) => p.turn !== native.start.turn)) throw Error("复核会话身份不符");
          if (native.permissions.some((p: any) => p.index > native.review.index && p.source === "user" && p.allowed)) throw Error("复核检查点之前已有人工授权操作");
          await options.onReviewCheckpoint?.(native);
          trace.event("review_checkpoint", { turn: native.start.turn, nativeIndex: native.review.index, reason: native.review.reason, budget: native.review.budget });
          checkpointTurn = sent;
          if (options.interruptOnReview && !interrupted) { input("\x03"); interrupted = true; }
        }
      }
      if (options.interruptMarker && !interrupted && stage === "running") {
        if ((await execute(runtime, ["test", "-f", options.interruptMarker], undefined, true)).exitCode === 0) { input("\x03"); interrupted = true; }
      }
      if (text.length > actionOffset && stage === "reason" && text.endsWith("拒绝理由（选填，回车跳过）：")) {
        actionOffset = text.length; input("保留原文件 keep.txt，不要修改或删除它。请把新内容另存为 copy.txt。\n"); stage = "running";
      } else if (text.length > actionOffset && stage === "running" && ["执行这次调用？[y/N] ", "应用这次修改？[y/N] ", "执行这次读取？[y/N] "].some(p => text.endsWith(p))) {
        // 新请求仍在流式返回时，不能用以前尚未授权的工具为伪造提示背书。
        if (state.activeRequests === 0) {
          const last = state.responses.at(-1);
          if (last?.stopReason !== "tool_use") throw new Error("permission prompt has no current completed tool response");
          await options.beforeInspect?.(runtime);
          const observed = JSON.parse((await execute(runtime, ["bun", "/opt/eval/v1-observe.ts"])).stdout);
          if (!observed.request || observed.index <= lastPermission) throw new Error("permission prompt has no fresh native request");
          const apiTool = last.content.find((t: any) => t.type === "tool_use" && t.id === observed.request.toolUseId);
          const pending = state.tools.find((t: any) => !t.approved && t.messageComplete && t.id === apiTool?.id && t.name === apiTool?.name);
          if (!apiTool || !pending) throw new Error("permission is not a pending tool of the latest response");
          const verified = verifyPermission(apiTool, observed);
          if (!text.endsWith(verified.expected)) {
            save(join(runtime.directory, "permission-mismatch.json"), { toolUseId: apiTool.id, expected: verified.expected, observedSuffix: text.slice(-verified.expected.length - 120) });
            throw new Error("terminal preview differs from independently verified tool proposal");
          }
          trace.event("permission_verified", { toolUseId: apiTool.id, nativeIndex: observed.index, proposalId: verified.view.proposalId, previewHash: verified.view.previewHash });
          await options.beforeApprove?.(apiTool, runtime);
          const permission = await control(batch, "permission", { id: runtime.id, tool_name: apiTool.name, input: apiTool.input, tool_use_id: apiTool.id });
          actionOffset = text.length; lastPermission = observed.index;
          input(permission.behavior === "allow" ? "y\n" : "n\n"); if (permission.behavior !== "allow") stage = "reason";
        }
      }
      if (text.length > actionOffset && text.endsWith("你 [medium] > ") && ["ready", "running"].includes(stage)) {
        if (!configuredReview && options.reviewMode !== undefined && sent === 0) {
          configuredReview = true; actionOffset = text.length; input(`/review ${options.reviewMode}\n`); continue;
        }
        if (sent > 0) {
          if (reviewAware) {
            const native = await observe();
            // 模型输出可伪造提示符；原生结束记录尚未写入时继续等，不提前封存。
            if (!native.end || native.start?.input !== prompts[sent - 1] || native.end.turn !== native.start.turn) { await Bun.sleep(40); continue; }
            save(join(runtime.directory, `native-turn-${sent}.json`), native);
            if (native.end.outcome === "completed") {
              const b = native.end.budget;
              if (!b || b.requests !== native.requests.length || b.requests !== state.budget.generationRequests - requestsAtTurn || native.requests.some((r: any, i: number) => r.budget?.requests !== i + 1)) throw Error("原生请求计数与转发器不一致");
              if (b.requests > 50 || b.reviewRequests > 10 || b.workRequests > (native.end.reviewMode === "auto" ? 40 : 50)) throw Error("原生阶段预算越界");
              if (options.reviewMode && native.end.reviewMode !== options.reviewMode) throw Error("复核模式与指定配置不符");
            }
            if (native.end.outcome !== "completed" && !(interrupted && native.end.outcome === "interrupted")) {
              status = native.end.outcome === "budget_exhausted" ? "budget_exhausted" : ["truncated", "refused", "review_incomplete"].includes(native.end.outcome) ? "candidate_unfinished" : "product_error";
              throw Error("native task ended: " + native.end.outcome);
            }
            if (native.end.reviewEligible && native.end.reviewMode === "auto" && !native.end.reviewed && !interrupted) throw Error("原生结束缺少必要复核");
            if (native.end.reviewed && checkpointTurn !== sent) throw Error("复核检查点未封存");
          }
          const last = state.responses.at(-1);
          if (state.responses.length <= responsesAtTurn && !interrupted) throw new Error("axi request failed before complete response");
          if (!interrupted && last?.stopReason === "tool_use") throw new Error("axi request failed after tool result");
          turns.push((last?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")); roundActiveMs.push(performance.now() - roundStarted);
          if (options.onRound) {
            const paused = performance.now();
            try { const next = await options.onRound(sent - 1); snapshots.push(next.snapshot); if (next.nextPrompt !== undefined) prompts[sent] = next.nextPrompt; }
            finally { excludedMs += performance.now() - paused; }
          } else { snapshots.push(await snapshot(runtime)); await options.onTurn?.(sent - 1); }
          roundStarted = performance.now();
        }
        if (sent === prompts.length) { input("/exit\n"); break; }
        actionOffset = text.length; responsesAtTurn = state.responses.length; requestsAtTurn = state.budget.generationRequests; input(prompts[sent++]! + "\n"); stage = "running";
      }
      if (child.exitCode !== null) throw new Error(`axi exited ${child.exitCode} before completing turns`);
      await Bun.sleep(40);
    }
    if (turns.length !== prompts.length) throw new Error("task deadline or incomplete turns");
    await Promise.race([child.exited, Bun.sleep(5000)]);
  } catch (e) {
    error = String(e); if (status === "completed") status = error.includes("request_budget") ? "budget_exhausted" : error.includes("deadline") ? "task_timeout" : /axi (exited|request failed)/.test(error) ? "product_error" : "runner_error";
    trace.event("error", { error }); input("\x03");
  } finally {
    await execute(runtime, ["pkill", "-KILL", "-f", entry], undefined, true).catch(() => {});
    child.kill("SIGKILL"); await child.exited; terminal.close(); trace.event("finish", { status, error, exitCode: child.exitCode, stderr: "merged_in_terminal" });
  }
  const proxy = await control(batch, "state", { id: runtime.id }); if (proxy.faults.includes("request_budget")) status = "budget_exhausted";
  await freeze(runtime);
  const result = { status, error, wallMs: performance.now() - started, activeMs: performance.now() - started - excludedMs, roundActiveMs, turns, snapshots, proxy, stdoutPath };
  save(join(runtime.directory, "execution.json"), result); return result;
}
