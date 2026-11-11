import { join } from "node:path";
import { readFileSync } from "node:fs";
import { save, execute, ROOT } from "../core.ts";
import { isolated } from "./runtime.ts";
import { taskFiles, codeInputHash, snapshotHash } from "./tasks.ts";
import { IMAGE, STUDY, TASKS } from "./settings.ts";

for (const task of TASKS) {
  const files = taskFiles(task, false), runtime = await isolated(IMAGE, task, `prepare-${Date.now()}-${task.toLowerCase()}`, files);
  try {
    const build = task === "C7-L" ? await execute(runtime, ["pnpm", "run", "build"], undefined, true, 180000) : undefined;
    if (build?.exitCode) throw new Error(build.stderr);
    const args = task === "C7-L" ? ["node", "c7/reproduce.mjs"] : ["bun", "c7/reproduce.ts"];
    const result = await execute(runtime, args, undefined, true, 45000);
    const observed = JSON.parse(result.stdout);
    if (result.exitCode !== 1 || observed.passed !== false) throw new Error("初态未按预期暴露缺陷");
    const report = { version: 1, time: new Date().toISOString(), codeInputSha256: codeInputHash(files), digestExcludes: ["c7/reproduction.json"], image: IMAGE, args, ...result, observed };
    save(join(STUDY, `${task}-reproduction.json`), report);
    const final = taskFiles(task); save(join(STUDY, `${task}-input.json`), final);
    save(join(STUDY, `${task}-input-manifest.json`), { task, sourceSha256: snapshotHash(final), codeInputSha256: codeInputHash(final), files: Object.keys(final).length, reproduction: report, originalSource: JSON.parse(readFileSync(join(ROOT, "docs/verification/2026-11-11-c7-source-review.json"), "utf8")).tasks.find((x: any) => x.task === task) });
    console.log(JSON.stringify({ task, defectReproduced: true, sourceSha256: snapshotHash(final), files: Object.keys(final).length }));
  } finally { await runtime.close(); }
}
