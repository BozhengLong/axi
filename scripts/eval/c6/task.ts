import { readFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ROOT, type Snapshot } from "../core.ts";
import { STUDY, POLICY_PATH, POLICY_BASE, POLICY_V1, POLICY_V2, NOTES_PATH, NOTES } from "./settings.ts";

export const file = (text: string, mode = 0o644) => ({ type: "file", mode, data: Buffer.from(text).toString("base64") });
export const contents = (entry: Snapshot[string]) => Buffer.from(entry.data!, "base64").toString();
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const snapshotHash = (files: Snapshot) => hash(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))));

export function upstreamFiles(): Snapshot {
  const root = join(STUDY, "build/upstream"); const files: Snapshot = {};
  const visit = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name, abs = join(root, path), stat = lstatSync(abs);
      if (stat.isDirectory()) visit(path);
      else files[path] = stat.isSymbolicLink() ? { type: "symlink", mode: stat.mode & 0o777, target: readlinkSync(abs) } : { type: "file", mode: stat.mode & 0o777, data: readFileSync(abs).toString("base64") };
    }
  };
  visit(""); return files;
}

export function protectionPaths(files: Snapshot) {
  return Object.keys(files).filter(path => /(^|\/)(tests\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig[^/]*\.json$|tsdown\.config\.ts$|jest[^/]*|LICENSE$)/.test(path) || /\.(?:e2e-)?spec\.tsx?$/.test(path) || path.startsWith("c6/") || path === POLICY_PATH || path === NOTES_PATH).sort();
}

export function seedFiles(): Snapshot {
  const files = upstreamFiles();
  files[POLICY_PATH] = file(POLICY_BASE);
  files["examples/c6-consumer/run.ts"] = file("import { Listr } from 'listr2';\nawait new Listr([{ title: '示例', task: () => {} }], { renderer: 'silent' }).run();\n");
  files["c6/contract-r1.md"] = file(readFileSync(join(ROOT, "evals/specs/c6-real-v1/contract-r1.md"), "utf8"));
  files["c6/brief.md"] = file(readFileSync(join(ROOT, "evals/specs/c6-real-v1/round-1.md"), "utf8"));
  files["c6/environment.md"] = file(`# 冻结环境与运行命令\n\nNode 24.22.2；pnpm 10.34.9；依赖已只读挂载。不能联网或安装包。\n\n- 构建：\`pnpm run build\`\n- 类型：\`pnpm run typecheck\`\n- 原测试及新增测试：\`pnpm -r --workspace-concurrency=1 run test --runInBand\`\n- 可见契约：\`node c6/visible.mjs 1\`\n- 外部类型：\`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ESNext --module NodeNext --moduleResolution NodeNext c6/types-visible.mts\`\n- 示例：\`node examples/c6-consumer/run.ts\`\n\n每次改动后需要重新构建，消费者使用 dist。原测试有 4 个原生 skipped，不应新增 skipped 或更新旧快照。node_modules、.git、.axi、.claude 不作为源文件归档；.git 状态与日志单独保留。禁止更改依赖、测试/构建配置，允许新增测试。\n`);
  files["c6/initial-changes.md"] = file(`# 初态用户修改\n\npolicy.ts 是已跟踪、未提交的用户修改。notes.md 是未跟踪的用户说明。两者路径均在 examples/c6-consumer/；必须保留内容、模式和 Git 状态。run.ts 可修改。不要提交、暂存或重置仓库。\n`);
  files["c6/visible.mjs"] = file(readFileSync(join(ROOT, "evals/c6-real-v1/oracle/visible.mjs.fixture"), "utf8"));
  files["c6/types-visible.mts"] = file(readFileSync(join(ROOT, "evals/c6-real-v1/oracle/types-r1.mts.fixture"), "utf8"));
  files["c6/protected-files.json"] = file(JSON.stringify([...protectionPaths(files), NOTES_PATH, "c6/types-visible.mts", "c6/protected-files.json"].filter((x, i, a) => a.indexOf(x) === i).sort(), null, 2) + "\n");
  return files;
}

export function currentSeed(round = 1): Snapshot {
  const files = seedFiles(); files[POLICY_PATH] = file(round === 3 ? POLICY_V2 : POLICY_V1); files[NOTES_PATH] = file(NOTES);
  if (round === 3) {
    files["c6/contract-r3.md"] = file(readFileSync(join(ROOT, "evals/specs/c6-real-v1/round-3.md"), "utf8"));
    files["c6/visible.mjs"] = file(readFileSync(join(ROOT, "evals/c6-real-v1/oracle/visible.mjs.fixture"), "utf8") + readFileSync(join(ROOT, "evals/c6-real-v1/oracle/visible-r3.mjs.fixture"), "utf8"));
    files["c6/types-visible.mts"] = file(contents(files["c6/types-visible.mts"]!) + readFileSync(join(ROOT, "evals/c6-real-v1/oracle/types-r3.mts.fixture"), "utf8"));
  }
  return files;
}

export function reference(round: number): Snapshot {
  const files = currentSeed(round);
  const change = (path: string, before: string, after: string) => {
    const text = contents(files[path]!); if (!text.includes(before)) throw new Error(`参考补丁未匹配：${path}`);
    files[path] = file(text.replace(before, after));
  };
  let renderer = readFileSync(join(ROOT, "evals/c6-real-v1/reference/jsonl-r1.ts.fixture"), "utf8");
  if (round === 3) {
    renderer = renderer.replace("  runId?: string", "  includeOutput?: boolean\n  transformText?: (text: string) => string\n  runId?: string");
    renderer = renderer.replace("    if (this.failed) return\n    try {", `    if (this.failed || (record.type === 'output' && this.options.includeOutput === false)) return\n    try {\n      if (this.options.transformText) {\n        record = { ...record }\n        for (const field of ['title', 'output']) if (field in record) {\n          const value = this.options.transformText(record[field] as string)\n          if (typeof value !== 'string') throw new TypeError('transformText must return a string')\n          record[field] = value\n        }\n      }`);
  }
  files["packages/listr2/src/renderer/jsonl.ts"] = file(renderer);
  change("packages/listr2/src/renderer/index.ts", "export * from './default'", "export * from './jsonl'\nexport * from './default'");
  change("packages/listr2/src/utils/ui/renderer.ts", "DefaultRenderer, SilentRenderer", "JsonlRenderer, DefaultRenderer, SilentRenderer");
  change("packages/listr2/src/utils/ui/renderer.ts", "Record<'default'", "Record<'jsonl' | 'default'");
  change("packages/listr2/src/utils/ui/renderer.ts", "  default: DefaultRenderer,", "  jsonl: JsonlRenderer,\n  default: DefaultRenderer,");
  const types = "packages/listr2/src/interfaces/renderer.interface.ts";
  change(types, "DefaultRenderer, SilentRenderer", "JsonlRenderer, DefaultRenderer, SilentRenderer");
  change(types, "export type ListrRendererValue =", "export type ListrJsonlRendererValue = 'jsonl'\nexport type ListrJsonlRenderer = typeof JsonlRenderer\n\nexport type ListrRendererValue =\n  | ListrJsonlRendererValue");
  change(types, "= T extends ListrDefaultRendererValue", "= T extends ListrJsonlRendererValue ? ListrJsonlRenderer : T extends ListrDefaultRendererValue");
  change(types, "= T extends DefaultRenderer", "= T extends typeof JsonlRenderer ? ListrJsonlRendererValue : T extends DefaultRenderer");
  files["examples/c6-consumer/run.ts"] = file(`import { Listr } from 'listr2';\n${round === 3 ? "const { formatText }: typeof import('./policy.js') = await import(new URL('./policy.ts', import.meta.url).href);\n" : ""}await new Listr([{ title: 'team=demo-internal', task: (_, task) => task.newListr([{ title: 'token=demo-secret', task: (_, task) => { task.output = '普通中文\\nteam=demo-internal token=demo-secret'; } }]) }], { renderer: 'jsonl', rendererOptions: { runId: 'example'${round === 3 ? ", transformText: formatText" : ""} } }).run();\n`);
  return files;
}
