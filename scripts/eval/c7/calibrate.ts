import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execute, save } from "../core.ts";
import { ROOT } from "../core.ts";
import { fingerprint } from "../complex/fingerprint.ts";
import { grade } from "./grade.ts";
import { taskFiles, reference, file, contents, snapshotHash } from "./tasks.ts";
import { IMAGE, STUDY, TASKS, type TaskId } from "./settings.ts";
import { isolated } from "./runtime.ts";
import { replay } from "./regression.ts";

const stamp = Date.now().toString(36), results: any[] = [], frozen = fingerprint();
const sourceDirectory = join(STUDY, `calibration-source-${stamp}`);
for (const path of Object.keys(frozen.hashes)) { const target = join(sourceDirectory, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, readFileSync(join(ROOT, path)), { mode: 0o600 }); }
const record = (value: any) => {
  if (fingerprint().sourceHash !== frozen.sourceHash) throw new Error("校准期间代码已改变");
  results.push(value); save(join(STUDY, "calibration.json"), { complete: false, image: IMAGE, sourceDirectory, ...frozen, results }); console.log(JSON.stringify(value)); if (!value.passed) throw new Error("C7 校准失败：" + value.name);
};
for (const task of TASKS) {
  const seed = taskFiles(task);
  for (const iteration of [1, 2]) {
    const name = `${task}-baseline-${iteration}`, g = await grade(IMAGE, task, `${stamp}-${name.toLowerCase()}`, seed, seed, join(STUDY, "calibration", name), { regression: false });
    const failures = g.checks.filter(c => !c.pass).map(c => c.id);
    const expected = task === "C7-L" ? ["L-COMPAT/H-END-DURING-SUBTASK", "L-REPRO", "L-EXTRA"] : ["O-COMPAT/故障钩子错误类型不改变 500 契约", "O-REPRO", "O-EXTRA"];
    record({ name, passed: JSON.stringify(failures.sort()) === JSON.stringify(expected.sort()), sourceSha256: snapshotHash(seed), failures });
  }
  const fixed = reference(task, seed), refName = `${task}-reference`;
  const r = await grade(IMAGE, task, `${stamp}-${refName.toLowerCase()}`, seed, fixed, join(STUDY, "calibration", refName));
  record({ name: refName, passed: r.codePassed && r.regressionPassed, failures: r.checks.filter(c => !c.pass).map(c => c.id), regressionPassed: r.regressionPassed, sourceSha256: snapshotHash(fixed) });
  const kinds = task === "C7-L" ? ["no-children", "remove-observers", "revive"] : ["all-500", "swallow", "one-stage"];
  for (const kind of kinds) {
    const mutant = structuredClone(fixed), path = task === "C7-L" ? "packages/listr2/src/renderer/jsonl/renderer.ts" : kind === "all-500" ? "src/http/app.ts" : "src/services/orders.ts";
    let text = contents(mutant[path]!);
    if (kind === "no-children") text = text.replace("this.subscribe(subtasks)", "void subtasks");
    if (kind === "remove-observers") text = text.replace("task.off(event, handler)", "task.off(event)");
    if (kind === "revive") text = text.replace("if (this.started || this.ended) {", "this.started = false; this.ended = false\n    if (false) {");
    if (kind === "all-500") text = text.replace('e instanceof BusinessError ? json({error:e.code},e.status) : json({error:"internal_error"},500)', 'json({error:"internal_error"},500)');
    if (kind === "swallow") text = text.replace('throw new Error("internal hook failure");', '/* 故意错误：吞掉故障。 */');
    if (kind === "one-stage") text = text.replace('try { hooks.fail?.(stage); }', 'if (stage !== "before_commit") { hooks.fail?.(stage); return; }\n    try { hooks.fail?.(stage); }');
    if (text === contents(mutant[path]!)) throw new Error("错误变体未匹配：" + kind);
    mutant[path] = file(text, mutant[path]!.mode);
    const name = `${task}-${kind}`, g = await grade(IMAGE, task, `${stamp}-${name.toLowerCase()}`, seed, mutant, join(STUDY, "calibration", name), { regression: false });
    const failures = g.checks.filter(c => !c.pass).map(c => c.id);
    const target = kind === "no-children" ? "L-COMPAT/V-TREE" : kind === "remove-observers" ? "L-COMPAT/V-LIFECYCLE" : kind === "revive" ? "L-COMPAT/H-REATTACH" : kind === "all-500" ? "O-COMPAT/非法请求与失败键不污染后续请求" : "O-COMPAT/故障钩子错误类型不改变 500 契约";
    record({ name, passed: failures.includes(target), target, failures, sourceSha256: snapshotHash(mutant) });
  }
  for (const kind of ["vacuous", "skipped", "bad-import"]) {
    const files = structuredClone(fixed), path = task === "C7-L" ? "packages/listr2/tests/c7-cleanup.e2e-spec.ts" : "tests/c7-fault.test.ts";
    const prefix = task === "C7-O" ? "import { test, expect } from 'bun:test';\n" : "";
    files[path] = file(kind === "vacuous" ? prefix + "test('空断言', () => expect(true).toBe(true));\n" : kind === "skipped" ? prefix + "test.skip('跳过', () => expect(true).toBe(true));\n" : prefix + "import {missing} from './does-not-exist'; test('错误导入', () => expect(missing).toBe(true));\n");
    const name = `${task}-test-${kind}`, id = `${stamp}-${name.toLowerCase()}`, env = await isolated(IMAGE, task, `${id}-current`, files);
    try {
      if (task === "C7-L") await execute(env, ["pnpm", "run", "build"], undefined, true, 180000);
      const observed = await replay(IMAGE, task, id, seed, files, env.name, () => {});
      save(join(STUDY, "calibration", name, "replay.json"), observed);
      record({ name, passed: !observed.valid, valid: observed.valid });
    } finally { await env.close(); }
  }
}
save(join(STUDY, "calibration.json"), { complete: true, image: IMAGE, sourceDirectory, ...frozen, results });
