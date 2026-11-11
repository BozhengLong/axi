import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type Snapshot } from "../core.ts";
import { file, contents, hash, snapshotHash } from "../c6/task.ts";
import { POLICY_PATH, NOTES_PATH } from "../c6/settings.ts";
import { STUDY, type TaskId } from "./settings.ts";

export { file, contents, hash, snapshotHash };
export const fixture = (name: string) => readFileSync(join(ROOT, "evals/c7-repair-v1", name + ".fixture"), "utf8");
export function clean(files: Snapshot): Snapshot {
  return Object.fromEntries(Object.entries(files).filter(([p, e]) => e.type !== "directory" && !/(^|\/)dist\//.test(p) && !p.endsWith("junit.xml") && !p.endsWith(".tsbuildinfo")));
}
export function source(task: TaskId): Snapshot {
  const review = JSON.parse(readFileSync(join(ROOT, "docs/verification/2026-11-11-c7-source-review.json"), "utf8"));
  const row = review.tasks.find((x: any) => x.task === task);
  const bytes = readFileSync(row.archivePath);
  if (hash(bytes) !== row.archiveSha256) throw new Error("C7 原始归档哈希改变");
  const files: Snapshot = JSON.parse(bytes.toString());
  for (const path of row.proposedOmittedPaths) delete files[path];
  const result = clean(files);
  if (Object.keys(result).length !== row.retainedRegularFilesBeforeNewTaskMaterials) throw new Error("C7 起点转换清单不符");
  return result;
}
export function protectedPaths(task: TaskId, files: Snapshot): string[] {
  return Object.keys(files).filter(p => p.startsWith("c7/") || p === "brief.md" || p === "contracts.md" || p.startsWith("c6/") || p === POLICY_PATH || p === NOTES_PATH ||
    /(^|\/)(tests\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig[^/]*\.json$|tsdown\.config\.ts$|jest[^/]*|LICENSE$)/.test(p) || /\.(?:e2e-)?spec\.tsx?$/.test(p)).sort();
}
export function taskFiles(task: TaskId, requireReproduction = true): Snapshot {
  const files = source(task), folder = task === "C7-L" ? "lifecycle" : "orders";
  const brief = readFileSync(join(ROOT, "evals/specs/c7-repair-v1", folder, "brief.md"), "utf8").replace(/^> 投递稿。.*\n\n/m, "");
  files[task === "C7-L" ? "c7/brief.md" : "brief.md"] = file(brief);
  files[task === "C7-L" ? "c7/reproduce.mjs" : "c7/reproduce.ts"] = file(fixture(task === "C7-L" ? "visible/lifecycle.mjs" : "visible/orders.ts"));
  files["c7/environment.md"] = file(task === "C7-L" ? `# 环境与命令\n\nNode 24.22.2 / pnpm 10.34.9，依赖只读，无公网。\n\n- 构建：\`pnpm run build\`\n- 类型：\`pnpm run typecheck\`\n- 全部原测试和新增测试：\`pnpm -r --workspace-concurrency=1 run test --runInBand\`\n- 复现：\`node c7/reproduce.mjs\`\n- 旧公开契约：\`node c6/visible.mjs 3\`\n- 外部类型：\`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ESNext --module NodeNext --moduleResolution NodeNext c6/types-visible.mts\`\n- 消费者：\`node examples/c6-consumer/run.ts\`\n\n新增测试放 packages/listr2/tests/ 中；单独运行可使用 \`pnpm --filter listr2 run test --runInBand --runTestsByPath tests/你的文件.e2e-spec.ts\`。先重新构建，避免读取旧 dist。原测试有 4 个 skipped，不新增跳过或更改原快照。policy.ts 是未暂存的用户修改；notes.md 是未跟踪的用户说明。不能提交或暂存。\n` : `# 环境与命令\n\nBun 1.3.14 / SQLite，TypeScript 预装。无需联网或安装。\n\n- 类型：\`bun run typecheck\`\n- 全部原测试和新增测试：\`bun test tests\`\n- 复现：\`bun c7/reproduce.ts\`\n- 新增独立测试：\`bun test ./tests/你的文件.test.ts\`\n\n临时数据库写入 /tmp；关闭连接并清理。当前 Git 为干净固定初态，不能提交或暂存。\n`);
  const reportPath = join(STUDY, `${task}-reproduction.json`);
  if (requireReproduction && !existsSync(reportPath)) throw new Error("尚未生成真实故障报告");
  files["c7/reproduction.json"] = file(existsSync(reportPath) ? readFileSync(reportPath, "utf8") : '{"status":"preparing"}\n');
  files["c7/protected-files.json"] = file("");
  files["c7/protected-files.json"] = file(JSON.stringify(protectedPaths(task, files), null, 2) + "\n");
  if (requireReproduction) {
    const report = JSON.parse(contents(files["c7/reproduction.json"]!));
    if (report.codeInputSha256 !== codeInputHash(files) || report.exitCode !== 1 || report.observed?.passed !== false) throw new Error("故障报告与当前输入不一致");
  }
  return files;
}
// 报告不能包含自身哈希；其余候选输入均参与这个摘要。
export const codeInputHash = (files: Snapshot) => snapshotHash(Object.fromEntries(Object.entries(files).filter(([p]) => p !== "c7/reproduction.json")));
export const newTests = (task: TaskId, seed: Snapshot, candidate: Snapshot) => Object.keys(candidate).filter(p => !seed[p] && candidate[p]?.type === "file" && (task === "C7-L" ? /^packages\/listr2\/tests\/.*\.(?:e2e-)?spec\.tsx?$/.test(p) : /^tests\/.*\.test\.tsx?$/.test(p))).sort();
export const newTestFiles = (task: TaskId, seed: Snapshot, candidate: Snapshot): Snapshot => Object.fromEntries(Object.entries(candidate).filter(([p, e]) => !seed[p] && e.type === "file" && p.startsWith(task === "C7-L" ? "packages/listr2/tests/" : "tests/")));
export function reference(task: TaskId, seed: Snapshot) {
  const files = structuredClone(seed), path = task === "C7-L" ? "packages/listr2/src/renderer/jsonl/renderer.ts" : "src/services/orders.ts";
  let text = contents(files[path]!);
  if (task === "C7-L") text = text.replace("private subscribe(tasks: ListrJsonlRendererTask[]): void {", "private subscribe(tasks: ListrJsonlRendererTask[]): void {\n    if (this.ended) return");
  else text = text.replace('  await hooks.enter?.();', '  await hooks.enter?.();\n  const fail = (stage: "after_inventory" | "after_order" | "before_commit") => {\n    try { hooks.fail?.(stage); } catch { throw new Error("internal hook failure"); }\n  };').replaceAll('hooks.fail?.("', 'fail("');
  if (text === contents(files[path]!)) throw new Error("参考修复未匹配");
  files[path] = file(text, files[path]!.mode);
  files[task === "C7-L" ? "packages/listr2/tests/c7-cleanup.e2e-spec.ts" : "tests/c7-fault.test.ts"] = file(fixture(task === "C7-L" ? "reference/lifecycle-test.ts" : "reference/orders-test.ts"));
  return files;
}
