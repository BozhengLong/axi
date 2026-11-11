import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { control, docker, save, type Batch, type Snapshot } from "../core.ts";
import { runAxi, runClaude } from "../adapters.ts";
import { helper } from "../c6/runtime.ts";
import { runtime, prepareGit, gitState, snapshot, cleanup } from "./runtime.ts";
import { clean, taskFiles, snapshotHash } from "./tasks.ts";
import { grade } from "./grade.ts";
import { classifyExecution } from "./outcome.ts";
import { RUN_MS, type TaskId } from "./settings.ts";

export async function job(batch: Batch, task: TaskId, agent: "axi" | "claude", repeat: number, id: string, options: { mock?: unknown[]; maxMs?: number; grade?: boolean; deadline?: number } = {}) {
  const seed = taskFiles(task), r = await runtime(batch, task, id, seed, options.mock);
  let busy = false, ended = false, resourceFailure = "";
  const watchdog = setInterval(async () => {
    if (busy || ended) return; busy = true;
    try {
      const usage = await helper(batch.image, r.taskVolume!, ["du", "-sk", "/task"]);
      if (usage.exitCode === 0 && Number(usage.stdout.split(/\s+/)[0]) > 2 * 1024 * 1024) { resourceFailure = "workspace_disk_budget"; await docker(["kill", r.name], undefined, true); }
    } catch (error) {
      resourceFailure = "resource_observer_error";
      appendFileSync(join(r.directory, "resource-errors.jsonl"), JSON.stringify({ time: new Date().toISOString(), error: String(error) }) + "\n", { mode: 0o600 });
      await docker(["kill", r.name], undefined, true);
    } finally { busy = false; }
  }, 10000);
  let record: any;
  try {
    const initialGit = await prepareGit(batch, r, task, seed);
    const initialFiles = clean(await snapshot(batch, r));
    if (!initialGit.valid || snapshotHash(initialFiles) !== snapshotHash(seed)) throw new Error("C7 初始工作目录与固定输入不符");
    save(join(r.directory, "initial-files.json"), seed);
    const prompt = `请在 /task 修复这份已有项目。先读 ${task === "C7-L" ? "c7/brief.md" : "brief.md"}、c7/environment.md、c7/reproduction.json 与 c7/protected-files.json，再自行复现、修复并补充有效回归。保护已有文件和 Git 状态，只处理当前公开要求。最后用中文报告实际修改、测试文件、执行命令和结果。`;
    save(join(r.directory, "input.json"), { task, prompt, sourceSha256: snapshotHash(seed) });
    const execution = await (agent === "axi" ? runAxi : runClaude)(batch, r, [prompt], {
      maxMs: options.maxMs ?? RUN_MS,
      onRound: async () => {
        for (let i = 0; ; i++) { const state = await control(batch, "state", { id }); if (!state.activeRequests) break; if (i >= 50) throw new Error("交付后仍有活动请求"); await Bun.sleep(100); }
        await docker(["pause", r.name]);
        try { const files = await snapshot(batch, r); save(join(r.directory, "delivery-files.json"), files); return { snapshot: files }; }
        finally { await docker(["unpause", r.name]); }
      }
    });
    ended = true; clearInterval(watchdog); while (busy) await Bun.sleep(25);
    const finalFiles: Snapshot = await snapshot(batch, r), finalGit = await gitState(r);
    save(join(r.directory, "final-files.json"), finalFiles); save(join(r.directory, "final-git.json"), finalGit);
    const events = readFileSync(join(batch.directory, "relay", id + ".jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    const status = resourceFailure || execution.status, classification = classifyExecution(status, events);
    const evaluated = options.grade === false ? undefined : await grade(batch.image, task, `${batch.id}-${id}`, seed, finalFiles, join(r.directory, "verification"), { executionStatus: status, git: finalGit, initialGit, deadline: options.deadline });
    record = { id, task, agent, repeat, status, classification, error: execution.error, codePassed: evaluated?.codePassed ?? false, regressionPassed: evaluated?.regressionPassed ?? false, fullDeliveryPassed: null, reportReview: "pending", wallMs: execution.wallMs, activeMs: execution.activeMs, budget: execution.proxy.budget, requests: execution.proxy.requests, config: execution.proxy.configs, transportIssues: execution.proxy.transportIssues, inputSha256: snapshotHash(seed), initialCommit: initialGit.head, finalSourceSha256: snapshotHash(finalFiles), failureChecks: evaluated?.checks.filter(c => !c.pass).map(c => c.id) ?? [], turns: execution.turns };
    save(join(r.directory, "result.json"), record);
    return record;
  } catch (error) {
    const failed = { id, task, agent, repeat, status: "infrastructure_error", classification: "evaluation_invalid", codePassed: false, regressionPassed: false, fullDeliveryPassed: null, error: String(error) };
    save(join(r.directory, "job-error.json"), failed);
    save(join(r.directory, "result.json"), failed); throw error;
  } finally {
    ended = true; clearInterval(watchdog); while (busy) await Bun.sleep(25);
    await cleanup(batch, r);
  }
}
