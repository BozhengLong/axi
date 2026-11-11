import { join } from "node:path";
import { readFileSync } from "node:fs";
import { initialize, docker, save } from "../core.ts";
import { fingerprint } from "../complex/fingerprint.ts";
import { job } from "./job.ts";
import { TASKS, STUDY } from "./settings.ts";

const batch = await initialize(), results: any[] = [];
try {
  for (const task of TASKS) for (const agent of ["axi", "claude"] as const) {
    const id = `smoke-${task}-${agent}`;
    const result = await job(batch, task, agent, 0, id, { maxMs: 20000, mock: [
      { content: [{ type: "tool_use", id: "smoke_write", name: agent === "axi" ? "bash" : "Bash", input: { command: "printf synthetic > smoke-marker.txt" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "模拟完成标记写入，没有修改业务代码，也没有声称修复缺陷。" }], stopReason: "end_turn" }
    ] });
    const passed = result.status === "completed" && !result.codePassed && !result.regressionPassed && result.failureChecks.includes(task === "C7-L" ? "L-REPRO" : "O-REPRO") && !result.failureChecks.some((x: string) => x === "C7-PROTECT" || x === "C7-GIT");
    results.push({ task, agent, passed, result }); save(join(STUDY, "smoke.json"), { complete: false, batch, results }); console.log(JSON.stringify({ id, passed }));
    if (!passed) throw new Error("C7 全流程模拟失败");
  }
  for (const agent of ["axi", "claude"] as const) {
    const id = `timeout-C7-O-${agent}`;
    const result = await job(batch, "C7-O", agent, 0, id, { maxMs: 5000, grade: false, mock: [
      { content: [{ type: "tool_use", id: "timeout_tool", name: agent === "axi" ? "bash" : "Bash", input: { command: "touch timeout-started.txt; sleep 20; touch timeout-escaped.txt" } }], stopReason: "tool_use" }
    ] });
    const files = JSON.parse(readFileSync(join(batch.directory, id, "final-files.json"), "utf8"));
    const passed = result.status === "task_timeout" && !!files["timeout-started.txt"] && !files["timeout-escaped.txt"];
    results.push({ agent, kind: "timeout", passed, result }); console.log(JSON.stringify({ id, passed }));
    if (!passed) throw new Error("C7 超时分类失败");
  }
  save(join(STUDY, "smoke.json"), { complete: true, batch: { id: batch.id, directory: batch.directory, image: batch.image }, sourceHash: fingerprint().sourceHash, results });
} finally { await docker(["rm", "-f", batch.relay], undefined, true); }
