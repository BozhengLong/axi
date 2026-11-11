import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./core.ts";
export type Task = { id: string; prompts: string[]; files: Record<string, string>; writable: string[] };
function files(root: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory() ? Object.entries(files(join(root, item.name), prefix + item.name + "/")) : [[prefix + item.name, readFileSync(join(root, item.name), "utf8")]]));
}
const common = "请在 /task 工作，使用中文。只能使用本地工具，不联网、不安装依赖、不启动后台服务。完成后说明实际验证结果。";
export function tasks(): Task[] {
  return [
    { id: "T1", prompts: [common + "阅读 brief.md 并严格按要求完成只读检查。最终只回复要求的 JSON。"], writable: [] },
    { id: "T2", prompts: [
      common + "阅读 brief.md 和 tasks.md，简述需要完成的功能。先不要修改文件。",
      "按 brief.md 实现 stats.ts，并用 bun run stats.ts tasks.md 实际运行验证。",
      "保留原有三项输出，再增加任务总数和完成率，格式分别为总数：N 和完成率：N.N%。总数为 0 时为 0.0%。实际运行验证。",
    ], writable: ["stats.ts"] },
    { id: "T3", prompts: [common + "阅读 brief.md，修复 parser.ts 并按要求验证。"], writable: ["parser.ts"] },
    { id: "T4", prompts: [common + "阅读 brief.md，实现 merge.ts 并按要求运行验证。"], writable: ["merge.ts"] },
  ].map(t => ({ ...t, files: files(join(ROOT, "evals/tasks", t.id)) }));
}
