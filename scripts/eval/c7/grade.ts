import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docker, execute, save, type Snapshot, type Batch } from "../core.ts";
import { grade as gradeListr } from "../c6/grade.ts";
import { gradeComplex } from "../complex/grade.ts";
import { POLICY_PATH, NOTES_PATH } from "../c6/settings.ts";
import { helper } from "../c6/runtime.ts";
import { clean, protectedPaths, fixture, file, contents, snapshotHash } from "./tasks.ts";
import { isolated, type gitState } from "./runtime.ts";
import { replay } from "./regression.ts";
import { GRADE_MS, type TaskId } from "./settings.ts";

export type Check = { id: string; pass: boolean; actual: unknown };
export type GitState = Awaited<ReturnType<typeof gitState>>;
export async function grade(image: string, task: TaskId, id: string, seed: Snapshot, candidate: Snapshot, directory: string, options: { executionStatus?: string; git?: GitState; initialGit?: GitState; regression?: boolean; deadline?: number } = {}) {
  const start = Date.now(), checks: Check[] = [], logs: Record<string, unknown> = {}, protectedFiles = protectedPaths(task, seed);
  let expired = false, timeoutCleanup: Promise<unknown> | undefined;
  const cleanupNames = [`axi-c6-verify-c7-${id}-base`, `axi-eval-c7-${id}-verify-base`, `axi-c7-${id}-extra`, `axi-c7-${id}-replay-old`];
  const limit = Math.min(GRADE_MS, (options.deadline ?? Infinity) - start);
  const timer = setTimeout(() => { expired = true; timeoutCleanup = docker(["kill", ...cleanupNames], undefined, true); }, Math.max(1, limit));
  const checkDeadline = () => { if (expired || Date.now() - start > limit) throw new Error("grade_deadline"); };
  const check = (id: string, pass: boolean, actual: unknown) => checks.push({ id, pass, actual });
  const changed = protectedFiles.filter(p => JSON.stringify(candidate[p]) !== JSON.stringify(seed[p]));
  check("C7-DELIVERY", (options.executionStatus ?? "completed") === "completed", options.executionStatus ?? "completed");
  check("C7-PROTECT", changed.length === 0, changed);
  if (options.git && options.initialGit) {
    const { git, initialGit } = options;
    const lines = git.status.trimEnd().split("\n").filter(Boolean);
    const staged = lines.filter(l => ![" ", "?"].includes(l[0]!));
    const policy = lines.find(l => l.endsWith(" " + POLICY_PATH));
    const notes = lines.find(l => l.endsWith(" " + NOTES_PATH));
    check("C7-GIT", git.valid && git.head === initialGit.head && staged.length === 0 && (task !== "C7-L" || (policy?.startsWith(" M") && notes?.startsWith("??"))) === true, { git, initialGit, staged });
  }
  let testReplay: Awaited<ReturnType<typeof replay>> | undefined;
  try {
    if (task === "C7-L") {
      const base = await gradeListr(image, `c7-${id}-base`, candidate, 3, join(directory, "compatibility"), undefined, false, {}, { files: seed, protectedPaths: protectedFiles });
      for (const c of [...base.visible, ...base.hidden]) check(`L-COMPAT/${c.id}`, c.status === "passed", c.observed);
      logs.base = base;
    } else {
      const batch = { id: `c7-${id}`, directory, image } as Batch;
      const base = await gradeComplex(batch, "base", { id: "C1", files: Object.fromEntries(Object.entries(seed).map(([p, e]) => [p, Buffer.from(e.data!, "base64")])), protected: protectedFiles, prompts: [] }, { status: options.executionStatus ?? "completed" }, candidate);
      for (const c of base.checks) check(`O-COMPAT/${c.name}`, c.pass, c.actual);
      logs.base = JSON.parse(readFileSync(join(directory, "base/verification.json"), "utf8"));
    }
    checkDeadline();
    const normalized = clean(candidate);
    for (const p of protectedFiles) normalized[p] = seed[p]!;
    const extra = await isolated(image, task, `${id}-extra`, normalized);
    try {
      const build = task === "C7-L" ? await execute(extra, ["pnpm", "run", "build"], undefined, true, 180000) : undefined;
      if (build) { logs.extraBuild = build; check("L-EXTRA-BUILD", build.exitCode === 0, build); }
      if (!build || build.exitCode === 0) {
        for (const kind of ["visible", "hidden"]) {
          checkDeadline();
          const path = task === "C7-L" ? `c7/${kind === "visible" ? "reproduce" : "hidden"}.mjs` : `c7/${kind === "visible" ? "reproduce" : "hidden"}.ts`;
          if (kind === "hidden") {
            const patch = await helper(image, extra.volume, ["bun", "/opt/eval/c6-files.ts", "patch"], true, JSON.stringify({ [path]: file(fixture(task === "C7-L" ? "oracle/lifecycle.mjs" : "oracle/orders.ts")) }));
            if (patch.exitCode) throw new Error(patch.stderr);
          }
          const result = await execute(extra, [task === "C7-L" ? "node" : "bun", path], undefined, true, 45000); logs[kind] = result;
          let parsed: any; try { parsed = JSON.parse(result.stdout); } catch {}
          const expectedCount = task === "C7-L" ? 3 : 18;
          check(`${task === "C7-L" ? "L" : "O"}-${kind === "visible" ? "REPRO" : "EXTRA"}`, result.exitCode === 0 && parsed?.passed === true && (kind !== "hidden" || parsed.cases?.length === expectedCount), parsed ?? result);
        }
        if (options.regression !== false) testReplay = await replay(image, task, id, seed, candidate, extra.name, checkDeadline);
      }
    } finally { await extra.close(); }
    checkDeadline();
    const result = { task, sourceSha256: snapshotHash(candidate), checks, codePassed: checks.every(c => c.pass), regressionPassed: testReplay?.valid ?? false, fullDeliveryPassed: null, reportReview: "pending", testReplay, logs, elapsedMs: Date.now() - start, complete: true };
    save(join(directory, "grade.json"), result); return result;
  } catch (error) {
    save(join(directory, "grade-error.json"), { task, error: String(error), expired, checks, logs, elapsedMs: Date.now() - start });
    throw error;
  } finally { clearTimeout(timer); await timeoutCleanup; }
}
