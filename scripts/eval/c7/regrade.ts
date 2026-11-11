import { readFileSync } from "node:fs";
import { join } from "node:path";
import { save } from "../core.ts";
import { fingerprint } from "../complex/fingerprint.ts";
import { grade } from "./grade.ts";
import { taskFiles, snapshotHash } from "./tasks.ts";
import { IMAGE, STUDY } from "./settings.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const original = read(join(STUDY, "formal-batch.json")), rows = read(join(original.directory, "results.json"));
const frozen = fingerprint(), results: any[] = [], stamp = Date.now().toString(36);
for (const row of rows) {
  const directory = join(original.directory, row.id), files = read(join(directory, "final-files.json"));
  if (snapshotHash(files) !== row.finalSourceSha256) throw new Error("原始产物改变");
  if (fingerprint().sourceHash !== frozen.sourceHash) throw new Error("复验期间代码改变");
  const result = await grade(IMAGE, row.task, `v2-${stamp}-${row.id}`, taskFiles(row.task), files, join(STUDY, "offline-v2", row.id), { executionStatus: row.status, initialGit: read(join(directory, "initial-git.json")), git: read(join(directory, "final-git.json")) });
  const previous = result.testReplay && "previous" in result.testReplay ? result.testReplay.previous : undefined;
  const current = result.testReplay && "current" in result.testReplay ? result.testReplay.current : undefined;
  const summary = { id: row.id, task: row.task, agent: row.agent, repeat: row.repeat, sourceSha256: result.sourceSha256, frozenCodePassed: row.codePassed, frozenRegressionPassed: row.regressionPassed, codePassed: result.codePassed, regressionPassed: result.regressionPassed, previous: previous ? { total: previous.total, passed: previous.passed, failed: previous.failed } : null, current: current ? { total: current.total, passed: current.passed, failed: current.failed } : null };
  results.push(summary); save(join(STUDY, "offline-v2/results.json"), { complete: false, suiteRevision: 2, ...frozen, results }); console.log(JSON.stringify(summary));
}
save(join(STUDY, "offline-v2/results.json"), { complete: true, suiteRevision: 2, ...frozen, results });
