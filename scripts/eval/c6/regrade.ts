import { readFileSync } from "node:fs";
import { join } from "node:path";
import { save, type Snapshot } from "../core.ts";
import { grade } from "./grade.ts";
import { file, snapshotHash, hash } from "./task.ts";
import { STUDY } from "./settings.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const calibration = read(join(STUDY, "calibration.json"));
if (!calibration.complete || !calibration.results.every((r: any) => r.passed) || !calibration.results.some((r: any) => r.name === "subscribe-after-end")) throw new Error("新验收尚未完成校准");
const original = read(join(STUDY, "formal-batch.json")), retry = read(join(STUDY, "formal-retry1-batch.json"));
const selected = [...read(join(original.directory, "results.json")).filter((r: any) => r.repeat !== 1).map((r: any) => ({ ...r, directory: original.directory })), ...read(join(retry.directory, "results.json")).map((r: any) => ({ ...r, directory: retry.directory }))];
if (selected.length !== 6 || selected.some(r => r.completedRounds !== 3)) throw new Error("本次离线复验需要六份完整正式轨迹");
const jobs = selected.flatMap(row => [1, 2, 3].map(round => ({ row, round })));
const results: any[] = [], stamp = Date.now().toString(36); let next = 0;
async function worker() {
  for (;;) {
    const index = next++; if (index >= jobs.length) return;
    const { row, round } = jobs[index]!, runDir = join(row.directory, row.id), directory = join(runDir, `round-${round}`);
    const candidate: Snapshot = read(join(directory, "files.json"));
    const old = read(join(directory, "grade.json"));
    if (snapshotHash(candidate) !== old.sourceSha256) throw new Error("原始保存产物改变");
    const extras: Snapshot = {};
    if (round > 1) {
      const feedbackText = readFileSync(join(runDir, "round-1/feedback.json"), "utf8"), feedback = JSON.parse(feedbackText), first = read(join(runDir, "round-1/grade.json"));
      const full = JSON.stringify({ checks: first.visible, commands: Object.fromEntries(Object.entries(first.commands).filter(([k]) => k !== "hidden")) }, null, 2) + "\n";
      if (hash(full) !== feedback.artifacts[0].sha256) throw new Error("原控制器反馈校验不符");
      extras["c6/feedback-r1.json"] = file(feedbackText);
      extras["c6/feedback-visible-full.json"] = file(full);
      extras["c6/round-2.md"] = file(readFileSync(join(row.directory, "source-snapshot/evals/specs/c6-real-v1/round-2.md"), "utf8").split("## 反馈包格式")[0]!);
    }
    const initial = read(join(runDir, "initial-git.json")), git = read(join(directory, "git.json"));
    const result = await grade("axi-eval-c6:formal-revision2", `offline-v3-${stamp}-${index}`, candidate, round, join(STUDY, "offline-v3", row.id, `round-${round}`), { status: git.status.stdout, head: git.head.stdout.trim(), expectedHead: initial.commit }, false, extras);
    const failures = [...result.visible, ...result.hidden].filter(c => c.status !== "passed").map(c => c.id);
    const summary = { id: row.id, agent: row.agent, repeat: row.repeat, round, sourceSha256: result.sourceSha256, frozenAccepted: old.accepted, accepted: result.accepted, failures };
    results.push(summary); save(join(STUDY, "offline-v3/results.json"), { complete: false, posthoc: true, suiteRevision: 3, results }); console.log(JSON.stringify(summary));
  }
}
const workers = await Promise.allSettled([worker(), worker()]);
const errors = workers.filter(x => x.status === "rejected");
if (errors.length) throw new AggregateError(errors.map(x => (x as PromiseRejectedResult).reason));
save(join(STUDY, "offline-v3/results.json"), { complete: true, posthoc: true, suiteRevision: 3, results: results.sort((a, b) => a.id.localeCompare(b.id) || a.round - b.round) });
