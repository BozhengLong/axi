import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { statfsSync } from "node:fs";
import { initialize, docker, save, createRuntime, destroyRuntime, ROOT } from "../core.ts";
import { fingerprint } from "../complex/fingerprint.ts";
import { runAxi, runClaude } from "../adapters.ts";
import { writeTraceIndex } from "../trace.ts";
import { job } from "./job.ts";
import { taskFiles, snapshotHash } from "./tasks.ts";
import { IMAGE, STUDY, schedule, TASKS } from "./settings.ts";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
if (process.argv[2] !== "--live") throw new Error("正式评测需要显式 --live");
const deadline = Number(process.env.AXI_C7_DEADLINE);
if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("必须设置未来绝对截止时间 AXI_C7_DEADLINE");
if (process.env.AXI_EVAL_IMAGE !== IMAGE) throw new Error("必须使用已确认的 C7 镜像 digest");
const calibration = read(join(STUDY, "calibration.json")), smoke = read(join(STUDY, "smoke.json")), preflight = read(join(STUDY, "preflight-approved.json"));
if (!calibration.complete || calibration.results.length !== 18 || !calibration.results.every((r: any) => r.passed)) throw new Error("C7 校准未完成");
if (!smoke.complete || smoke.results.length !== 6 || !smoke.results.every((r: any) => r.passed)) throw new Error("C7 模拟前置未完成");
const frozen = fingerprint();
if (calibration.sourceHash !== frozen.sourceHash || smoke.sourceHash !== frozen.sourceHash) throw new Error("校准或模拟检查不是当前冻结代码");
if (!preflight.pass || !preflight.complete || !preflight.live || preflight.image !== IMAGE || preflight.sourceHash !== frozen.sourceHash) throw new Error("当前源码的完整真实前置未通过");
const inputs = Object.fromEntries(TASKS.map(task => [task, snapshotHash(taskFiles(task))]));
for (const task of TASKS) for (const n of [1, 2]) if (calibration.results.find((r: any) => r.name === `${task}-baseline-${n}`)?.sourceSha256 !== inputs[task]) throw new Error("正式输入与校准基线不同");
if (smoke.results.some((r: any) => r.result.inputSha256 !== inputs[r.result.task])) throw new Error("正式输入与模拟检查不同");
writeFileSync(join(STUDY, "formal.claim"), JSON.stringify({ sourceHash: frozen.sourceHash, deadline: new Date(deadline).toISOString(), time: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
const batch = await initialize(), results: any[] = [], selection: any[] = [], health: any[] = [], attempts: any[] = [];
let recoveryUsed = false, stopReason: string | undefined;
const gitHeads: Record<string, string> = {};
save(join(STUDY, "formal-batch.json"), { id: batch.id, directory: batch.directory });
for (const path of Object.keys(frozen.hashes)) {
  const target = join(batch.directory, "source-snapshot", path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(join(ROOT, path)), { mode: 0o600 });
}
const manifest = { batch: batch.id, suite: "c7-repair-v1", suiteRevision: 1, traceVersion: 2, created: new Date().toISOString(), deadline: new Date(deadline).toISOString(), hostDiskReserveBytes: 4 * 1024 ** 3, image: IMAGE, model: "claude-opus-5-5", effort: "medium", schedule, inputs, calibration, smoke: { batch: smoke.batch, results: smoke.results.map((x: any) => ({ task: x.task, agent: x.agent, kind: x.kind, passed: x.passed })) }, preflight, ...frozen };
save(join(batch.directory, "manifest.json"), manifest);
const persist = () => { save(join(batch.directory, "results.json"), results); save(join(batch.directory, "selection.json"), selection); save(join(batch.directory, "attempts.json"), attempts); };
async function healthCheck() {
  for (const agent of ["axi", "claude"] as const) {
    const id = `health-recovery-${agent}`, r = await createRuntime(batch, id, { maxRounds: 1, maxTotal: 5 });
    try {
      const e = await (agent === "axi" ? runAxi : runClaude)(batch, r, ["只回复 C7-READY，不调用工具。"], { maxMs: 60000 });
      const passed = e.status === "completed" && e.turns.join("\n").includes("C7-READY");
      health.push({ id, agent, passed, status: e.status, budget: e.proxy.budget }); save(join(batch.directory, "recovery-health.json"), health);
      if (!passed) return false;
    } finally { await destroyRuntime(batch, r); }
  }
  return true;
}
async function pair(index: number, retry: boolean) {
  const spec = schedule[index]!, rows: any[] = [];
  for (const agent of spec.agents) {
    if (fingerprint().sourceHash !== frozen.sourceHash) throw new Error("C7 正式源码在运行中改变");
    if (snapshotHash(taskFiles(spec.task)) !== inputs[spec.task]) throw new Error("C7 固定输入改变");
    if (Date.now() + 45 * 60_000 >= deadline) throw new Error("无法在全局截止前容纳完整单次运行与验收");
    const id = `formal-${spec.task}-r${spec.repeat}-${agent}${retry ? "-retry1" : ""}`;
    attempts.push({ id, task: spec.task, agent, repeat: spec.repeat, retry, time: new Date().toISOString() }); persist();
    let row: any;
    try { row = await job(batch, spec.task, agent, spec.repeat, id, { deadline }); }
    catch (error) { const path = join(batch.directory, id, "result.json"); if (existsSync(path)) results.push(read(path)); persist(); throw error; }
    if (gitHeads[spec.task] && gitHeads[spec.task] !== row.initialCommit) throw new Error("同题初始 Git 提交不同");
    gitHeads[spec.task] = row.initialCommit;
    row.pair = index + 1; row.retry = retry;
    results.push(row); rows.push(row); persist();
    console.log(JSON.stringify({ id, status: row.status, classification: row.classification, codePassed: row.codePassed, regressionPassed: row.regressionPassed, requests: row.budget?.generationRequests }));
    if (row.classification === "unclassified_failure") throw new Error("未分类运行异常，停止后续配对并保留现场");
  }
  return rows;
}
try {
  for (let index = 0; index < schedule.length; index++) {
    if (Date.now() + 130 * 60_000 > deadline) { stopReason = "insufficient_pair_window"; break; }
    const disk = statfsSync(STUDY);
    if (disk.bavail * disk.bsize < manifest.hostDiskReserveBytes) { stopReason = "host_disk_headroom"; break; }
    const original = await pair(index, false);
    if (!original.some(r => r.classification === "environment_indeterminate")) { selection.push({ pair: index + 1, ids: original.map(r => r.id), retry: false }); persist(); continue; }
    save(join(batch.directory, `incident-pair-${index + 1}.json`), { classification: "environment_indeterminate", pair: index + 1, originalIds: original.map(r => r.id), sourceHash: frozen.sourceHash, time: new Date().toISOString() });
    if (recoveryUsed || Date.now() + 132 * 60_000 > deadline) { stopReason = recoveryUsed ? "recovery_limit" : "insufficient_recovery_window"; break; }
    recoveryUsed = true;
    writeFileSync(join(batch.directory, "recovery.claim"), JSON.stringify({ pair: index + 1, time: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
    if (!await healthCheck()) { stopReason = "recovery_health_failed"; break; }
    const retry = await pair(index, true);
    if (retry.some(r => r.classification === "environment_indeterminate")) { stopReason = "recovery_failed"; break; }
    selection.push({ pair: index + 1, ids: retry.map(r => r.id), retry: true, supersededIds: original.map(r => r.id) }); persist();
  }
} catch (error) {
  stopReason = "infrastructure_or_protocol_error"; save(join(batch.directory, "run-error.json"), { error: String(error), time: new Date().toISOString() }); throw error;
} finally {
  persist(); save(join(batch.directory, "completion.json"), { complete: selection.length === 6, starts: attempts.length, gradedResults: results.length, adoptedRuns: selection.length * 2, recoveryUsed, stopReason, time: new Date().toISOString() });
  writeTraceIndex(batch.directory); await docker(["rm", "-f", batch.relay], undefined, true);
}
console.log(JSON.stringify({ batch: batch.id, starts: results.length, adoptedRuns: selection.length * 2, complete: selection.length === 6, stopReason }));
