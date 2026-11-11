import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { current, createRuntime, destroyRuntime, snapshot, save, docker, ROOT, type Runtime } from "./core.ts";
import { runAxi, runClaude } from "./adapters.ts";
import { tasks } from "./tasks.ts";
import { grade } from "../../evals/oracles/grade.ts";

if (!process.argv.includes("--live")) throw new Error("正式对照需显式传入 --live；先运行 preflight.ts --live");
const b = current(), gate = JSON.parse(readFileSync(join(b.directory, "preflight.json"), "utf8"));
if (!gate.pass || !gate.complete || !gate.live || gate.image !== b.image) throw new Error("前置检查未完整通过或镜像发生变化");
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sourceFiles(join(directory, e.name)) : [join(directory, e.name)]);
const hashes = Object.fromEntries([...['src', 'scripts/eval', 'evals', 'tests'].flatMap(p => sourceFiles(join(ROOT, p))), ...['package.json', 'bun.lock', 'tsconfig.json', '.dockerignore'].map(p => join(ROOT, p))].sort().map(p => [relative(ROOT, p), createHash("sha256").update(readFileSync(p)).digest("hex")]));
const sourceHash = createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
const selected = tasks();
let seed = 20261110;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const pairs = selected.flatMap(t => [1, 2, 3].map(repeat => ({ task: t.id, repeat })));
for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!]; }
const schedule = pairs.flatMap((pair, i) => (i % 2 === 0 ? ["axi", "claude"] : ["claude", "axi"]).map(agent => ({ ...pair, agent, id: `formal-${String(i + 1).padStart(2, "0")}-${pair.task}-r${pair.repeat}-${agent}` })));
const manifestPath = join(b.directory, "manifest.json");
const manifest = { batch: b.id, traceVersion: 2, sourceSnapshot: "source-snapshot", created: new Date().toISOString(), image: b.image, seed: 20261110, model: "claude-opus-5-5", effort: "medium", sourceHash, hashes, schedule, preflight: gate, taskPrompts: selected.map(t => ({ id: t.id, prompts: t.prompts })) };
if (existsSync(manifestPath)) {
  const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (previous.sourceHash !== sourceHash) throw new Error("已有批次的源码或测试已改变，需要新的批次，不能混用");
} else {
  for (const name of Object.keys(hashes)) {
    const target = join(b.directory, "source-snapshot", name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(join(ROOT, name)), { mode: 0o600, flag: "wx" });
  }
  save(manifestPath, manifest);
}

const results: any[] = [];
for (const entry of schedule) {
  const resultPath = join(b.directory, `${entry.id}-result.json`);
  if (existsSync(resultPath)) { results.push(JSON.parse(readFileSync(resultPath, "utf8"))); continue; }
  const task = selected.find(t => t.id === entry.task)!;
  console.log(JSON.stringify({ event: "start", index: results.length + 1, total: 24, ...entry }));
  let runtime: Runtime | undefined;
  try {
    runtime = await createRuntime(b, entry.id, { files: task.files });
    const execution = await (entry.agent === "axi" ? runAxi : runClaude)(b, runtime, task.prompts);
    const final = await snapshot(runtime); save(join(runtime.directory, "final-files.json"), final);
    const verdict = await grade(b, entry.id, task, execution, final);
    const events = readFileSync(`${b.directory}/relay/${entry.id}.jsonl`, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const requests = events.filter(e => e.kind === "request").map(e => e.data.body);
    const modelMatched = requests.every(q => q.model === "claude-opus-5-5" && q.output_config?.effort === "medium") && execution.proxy.responses.every((r: any) => r.model === "claude-opus-5-5");
    const usage = execution.proxy.responses.reduce((sum: Record<string, number>, r: any) => {
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) sum[k] = (sum[k] ?? 0) + (r.usage[k] ?? 0);
      return sum;
    }, {});
    const result = { ...entry, status: execution.status, pass: verdict.pass && modelMatched && execution.proxy.faults.length === 0, modelMatched, faults: execution.proxy.faults, transportIssues: execution.proxy.transportIssues ?? [], error: execution.error, wallMs: execution.wallMs, modelMs: execution.proxy.responses.reduce((n: number, r: any) => n + r.requestMs, 0), requests: execution.proxy.requests, tools: execution.proxy.tools.length, permissions: execution.proxy.permissions.length, usage, checks: verdict.checks, finished: new Date().toISOString() };
    save(resultPath, result); results.push(result); save(join(b.directory, "results.json"), results);
    console.log(JSON.stringify({ event: "result", index: results.length, task: entry.task, repeat: entry.repeat, agent: entry.agent, pass: result.pass, status: result.status, seconds: +(result.wallMs / 1000).toFixed(1), failedChecks: result.checks.filter(c => !c.pass).map(c => c.name), faults: result.faults }));
    if (!modelMatched || result.faults.length || ["runner_error", "product_or_runner_error"].includes(result.status) || verdict.checks.some(c => c.name === "验收环境完成" && !c.pass)) throw new Error("出现不可归因于任务质量的异常，已保存样本并暂停批次");
  } finally { if (runtime) await destroyRuntime(b, runtime); }
  if (runtime) {
    const trace = JSON.parse(readFileSync(join(runtime.directory, "trace-manifest.json"), "utf8"));
    if (trace.status !== "complete_observable") throw new Error(`trace 未收齐：${trace.missing.join("、")}`);
  }
}
save(join(b.directory, "completion.json"), { completed: results.length === 24, count: results.length, time: new Date().toISOString() });
console.log(JSON.stringify({ event: "completed", batch: b.id, runs: results.length, axiPassed: results.filter(r => r.agent === "axi" && r.pass).length, claudePassed: results.filter(r => r.agent === "claude" && r.pass).length }));
