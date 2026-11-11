import { readFileSync } from "node:fs";
import { join } from "node:path";
import { current, docker, control, save, execute, type Snapshot } from "../core.ts";
import { runAxi, runClaude } from "../adapters.ts";
import { c6Runtime, capturePaused, patchPaused, helper, cleanup } from "./runtime.ts";
import { seedFiles, file, contents } from "./task.ts";
import { prepareWorkspace } from "./workspace.ts";
import { POLICY_PATH, POLICY_V2, STUDY } from "./settings.ts";

const batch = current(), checks: unknown[] = [], stamp = Date.now().toString(36);
const textReply = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
for (const agent of ["axi", "claude"] as const) {
  const tool = (n: number, command: string) => ({ content: [{ type: "tool_use", id: `c6-${agent}-${n}`, name: agent === "axi" ? "bash" : "Bash", input: { command } }], stopReason: "tool_use" });
  const mock = [tool(1, "printf round1 > marker.txt"), textReply("一轮完成"), tool(2, "test -f feedback.txt && printf round2 >> marker.txt"), textReply("二轮完成"), tool(3, "test -f feedback.txt && test -f marker.txt && printf round3 >> marker.txt"), textReply("三轮完成")];
  const fixtures = { ...seedFiles(), "c6/mock-exec.sh": file("#!/bin/sh\nprintf OK\n", 0o755), "c6/mock-data.bin": { type: "file", mode: 0o644, data: Buffer.from([0, 255, 128, 10]).toString("base64") }, "c6/mock-link": { type: "symlink", mode: 0o777, target: "mock-data.bin" } };
  const runtime = await c6Runtime(batch, `c6-continuity-${stamp}-${agent}`, fixtures, mock);
  try {
    const commit = await prepareWorkspace(batch, runtime); const seen: Snapshot[] = [], tops: string[] = [];
    if ((await execute(runtime, ["./c6/mock-exec.sh"])).stdout !== "OK") throw new Error("可执行位未保留");
    if ((await execute(runtime, ["touch", "node_modules/forbidden"], undefined, true)).exitCode === 0) throw new Error("依赖目录可写");
    const result = await (agent === "axi" ? runAxi : runClaude)(batch, runtime, ["执行第一轮模拟任务", "", ""], {
      maxMs: 45000, roundMaxMs: 15000,
      onRound: async index => {
        const state = await control(batch, "state", { id: runtime.id });
        if (state.activeRequests) throw new Error("CLI 已交付但模型请求仍活跃");
        tops.push((await docker(["top", runtime.name, "-eo", "pid,args"])).stdout);
        await docker(["pause", runtime.name]);
        try {
          const snap = await capturePaused(batch, runtime); seen.push(snap);
          if (snap["c6/mock-data.bin"]?.data !== fixtures["c6/mock-data.bin"].data || snap["c6/mock-exec.sh"]?.mode !== 0o755 || snap["c6/mock-link"]?.target !== "mock-data.bin") throw new Error("二进制、权限或符号链接快照改变");
          if (contents(snap["marker.txt"]!) !== ["round1", "round1round2", "round1round2round3"][index]) throw new Error("轮间工作目录丢失");
          const readonly = await helper(batch.image, runtime.taskVolume!, ["sh", "-c", "printf forbidden > marker.txt"]);
          if (readonly.exitCode === 0) throw new Error("只读快照挂载可写");
          // 每次验收停留超过单轮活动预算，证明控制器等待不会耗尽 agent 时间。
          if (index === 0) { await patchPaused(batch, runtime, { "feedback.txt": file("真实模拟反馈\n") }); await Bun.sleep(16000); }
          if (index === 1) await patchPaused(batch, runtime, { [POLICY_PATH]: file(POLICY_V2) });
          if (index < 2) await control(batch, "next-round", { id: runtime.id, expectedRound: index + 1 });
          return { snapshot: snap, ...(index < 2 ? { nextPrompt: `执行第 ${index + 2} 轮模拟任务，沿用历史和已有文件。` } : {}) };
        } finally { await docker(["unpause", runtime.name]); }
      }
    });
    const requests = readFileSync(join(batch.directory, "relay", runtime.id + ".jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.kind === "request" && e.data.path === "/v1/messages");
    const final = seen[2];
    const allHistory = JSON.stringify(requests.at(-1)?.data.body.messages ?? []);
    const cliMarker = agent === "axi" ? "/opt/axi/src/main.ts" : "claude -p";
    const pids = tops.map(text => text.split("\n").find(line => line.includes(cliMarker))?.trim().split(/\s+/)[0]);
    const passed = result.status === "completed" && result.turns.length === 3 && new Set(pids).size === 1 && pids.every(Boolean) && allHistory.includes("一轮完成") && allHistory.includes("二轮完成") && final && contents(final[POLICY_PATH]!) === POLICY_V2 && result.proxy.budget.round === 3 && result.proxy.budget.generationRequests === 6;
    const check = { agent, passed, commit, status: result.status, error: result.error, pids, rounds: result.turns.length, budget: result.proxy.budget, wallMs: result.wallMs, activeMs: result.activeMs, roundActiveMs: result.roundActiveMs, historyPreserved: allHistory.includes("一轮完成") && allHistory.includes("二轮完成") };
    checks.push(check); save(join(STUDY, "continuity-preflight.json"), checks); console.log(JSON.stringify(check));
    if (!passed) throw new Error("连续会话前置失败");
  } finally { await cleanup(batch, runtime); }
}
