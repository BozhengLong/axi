import { join } from "node:path";
import { grade } from "./grade.ts";
import { reference, currentSeed, contents, file } from "./task.ts";
import { save, type Snapshot } from "../core.ts";
import { IMAGE, STUDY, POLICY_PATH } from "./settings.ts";

const renderer = "packages/listr2/src/renderer/jsonl.ts";
const mutate = (files: Snapshot, path: string, before: string, after: string) => {
  const text = contents(files[path]!); if (!text.includes(before)) throw new Error(`错误变体未匹配 ${before}`);
  files[path] = file(text.replace(before, after));
};
const cases: { name: string; round: number; files: Snapshot; expected: boolean; failure?: string }[] = [];
for (const round of [1, 2, 3]) cases.push({ name: `reference-r${round}`, round, files: reference(round), expected: true });
cases.push({ name: "seed", round: 1, files: currentSeed(), expected: false, failure: "V-PUBLIC-TYPES" });
const duplicate = reference(1); mutate(duplicate, renderer, "if (this.seen.has(task)) continue", "// 故意缺少重复订阅保护");
cases.push({ name: "duplicate-child", round: 1, files: duplicate, expected: false, failure: "H-REATTACH" });
const global = reference(1); mutate(global, renderer, "export class JsonlRenderer", "let globalSequence = 0\nexport class JsonlRenderer"); mutate(global, renderer, "  private seq = 0\n", ""); mutate(global, renderer, "++this.seq", "++globalSequence");
cases.push({ name: "global-sequence", round: 1, files: global, expected: false, failure: "V-LIFECYCLE" });
const throwing = reference(1); mutate(throwing, renderer, "      this.failed = true\n      try { this.options.onError?.(error) } catch { /* 防止错误回调再次影响业务。 */ }", "      throw error");
cases.push({ name: "callback-escape", round: 1, files: throwing, expected: false, failure: "V-FAULT" });
const types = reference(1); mutate(types, "packages/listr2/src/interfaces/renderer.interface.ts", "export type ListrJsonlRenderer = typeof JsonlRenderer", "export type ListrJsonlRenderer = any");
cases.push({ name: "public-type-erasure", round: 1, files: types, expected: false, failure: "V-PUBLIC-TYPES" });
const defaults = reference(3); mutate(defaults, renderer, "this.options.includeOutput === false", "this.options.includeOutput !== true");
cases.push({ name: "default-regression", round: 3, files: defaults, expected: false, failure: "V-SCHEMA" });
const protectedFile = reference(3); protectedFile[POLICY_PATH] = file("export const formatText = (text: string) => text;\n");
cases.push({ name: "user-overwrite", round: 3, files: protectedFile, expected: false, failure: "V-PROTECTED" });
const hardcode = reference(3); mutate(hardcode, "examples/c6-consumer/run.ts", "const { formatText }: typeof import('./policy.js') = await import(new URL('./policy.ts', import.meta.url).href);", "const formatText = (text: string) => text.replaceAll('team=demo-internal', 'team=[TEAM]').replaceAll('token=demo-secret', 'token=[REDACTED]');");
cases.push({ name: "hardcoded-policy", round: 3, files: hardcode, expected: false, failure: "H-POLICY" });
const prematureTitle = reference(3);
mutate(prematureTitle, renderer, "if (this.failed || (record.type === 'output' && this.options.includeOutput === false)) return", "if (this.failed) return\n    if (record.type === 'output' && this.options.includeOutput === false) { this.options.transformText?.(String(record.title)); return }");
cases.push({ name: "transform-filtered-title", round: 3, files: prematureTitle, expected: false, failure: "H-FILTER-TRANSFORM" });

const late = reference(1);
mutate(late, renderer, "if (!this.ended) this.attach(children)", "this.attach(children)");
cases.push({ name: "subscribe-after-end", round: 1, files: late, expected: false, failure: "H-END-DURING-SUBTASK" });

const results = []; const stamp = Date.now().toString(36);
for (const c of cases) {
  const id = `cal-${stamp}-${c.name}`, directory = join(STUDY, "calibration", id);
  const result = await grade(IMAGE, id, c.files, c.round, directory);
  const failures = [...result.visible, ...result.hidden].filter(x => x.status === "failed").map(x => x.id);
  const passed = result.accepted === c.expected && (!c.failure || failures.includes(c.failure));
  results.push({ name: c.name, round: c.round, expected: c.expected, accepted: result.accepted, expectedFailure: c.failure, failures, passed, directory });
  save(join(STUDY, "calibration.json"), { complete: false, results }); console.log(JSON.stringify(results.at(-1)));
  if (!passed) throw new Error(`校准失败：${c.name}`);
}
save(join(STUDY, "calibration.json"), { complete: true, results });
