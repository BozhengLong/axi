import { join, dirname } from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { ROOT, STORE, initialize, createRuntime, destroyRuntime, execute, save, docker, type SeedFiles } from "../core.ts";
import { runAxi, runClaude } from "../adapters.ts";
import { runAxiV1, type V1Options } from "./adapter.ts";
import { writeTraceIndex } from "../trace.ts";
import { fingerprint } from "../complex/fingerprint.ts";

const study = join(STORE, "v1-20261112");
if (!process.env.AXI_EVAL_IMAGE?.startsWith("sha256:")) throw new Error("模拟前置必须显式固定镜像 ID");
const batch = await initialize(), results: any[] = [], frozen = fingerprint();
for (const path of Object.keys(frozen.hashes)) { const dest = join(batch.directory, "source-snapshot", path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, readFileSync(join(ROOT, path)), { mode: 0o600 }); }
save(join(batch.directory, "manifest.json"), { batch: batch.id, suite: "v1-smoke", traceVersion: 2, image: batch.image, mockOnly: true, ...frozen });
const text = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const call = (id: string, name: string, input: object, versionFrom?: string) => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", ...(versionFrom ? { versionFrom } : {}) });
async function check(id: string, variant: "old" | "new" | "claude", files: SeedFiles, mock: unknown[], verify: (x: any, r: any) => Promise<boolean> | boolean, options: V1Options = {}, policy = "normal", prompts = ["完成指定测试"]) {
  const r = await createRuntime(batch, id, { files, mock, policy, maxRounds: prompts.length, maxTotal: 12 });
  save(join(r.directory, "input.json"), { id, variant, files, mock, policy, prompts });
  let execution: any;
  try {
    execution = await (variant === "new" ? runAxiV1 : variant === "old" ? runAxi : runClaude)(batch, r, prompts, { maxMs: 30000, ...options, ...(variant === "old" ? { axiEntry: "/opt/axi-v0/src/main.ts" } : {}) });
    const passed = await verify(execution, r);
    const entry = { id, task: id, repeat: 1, agent: variant === "claude" ? "claude" : "axi", variant, passed, execution };
    results.push(entry); save(join(r.directory, "smoke-result.json"), { id, variant, passed });
  } finally { await destroyRuntime(batch, r); }
  const trace = JSON.parse(readFileSync(join(r.directory, "trace-manifest.json"), "utf8"));
  const entry = results.at(-1); entry.traceComplete = trace.status === "complete_observable"; entry.passed &&= entry.traceComplete;
  save(join(batch.directory, "results.json"), results); console.log(JSON.stringify({ id, passed: entry.passed, status: execution?.status, error: execution?.error }));
  if (!entry.passed) throw new Error("模拟检查失败：" + id);
}
const content = (x: any, path: string) => Buffer.from(x.snapshots.at(-1)?.[path]?.data ?? "", "base64").toString();
let complete = false;
try {
  await check("v1-new-allow", "new", { "a.txt": "before\n" }, [call("r", "read", { path: "a.txt" }), call("e", "edit", { path: "a.txt", old_text: "before", new_text: "after", base_version: "FROM_READ" }, "r"), call("w", "write", { path: "new.txt", content: "新文件🙂\n" }), call("b", "bash", { command: "cat a.txt > verified.txt" }), text("完成")], x => x.status === "completed" && content(x, "a.txt") === "after\n" && content(x, "new.txt") === "新文件🙂\n" && content(x, "verified.txt") === "after\n" && x.proxy.permissions.length === 3);
  await check("v1-new-deny", "new", { "keep.txt": "original\n" }, [call("r", "read", { path: "keep.txt" }), call("e", "edit", { path: "keep.txt", base_version: "FROM_READ", old_text: "original", new_text: "bad" }, "r"), call("w", "write", { path: "copy.txt", content: "replacement\n" }), text("已另存")], x => x.status === "completed" && content(x, "keep.txt") === "original\n" && content(x, "copy.txt") === "replacement\n" && x.proxy.permissions.map((p: any) => p.behavior).join(",") === "deny,allow", {}, "deny-first");
  await check("v1-new-conflict", "new", { "a.txt": "before\n" }, [call("r", "read", { path: "a.txt" }), call("e", "edit", { path: "a.txt", base_version: "FROM_READ", old_text: "before", new_text: "bad" }, "r"), text("冲突停止")], x => x.status === "completed" && content(x, "a.txt") === "external\n", { beforeApprove: async (tool, r) => { if (tool.name === "edit") await execute(r, ["bun", "-e", 'await Bun.write("/task/a.txt","external\\n")']); } });
  await check("v1-new-mismatch", "new", { "a.txt": "before\n" }, [call("r", "read", { path: "a.txt" }), call("e", "edit", { path: "a.txt", base_version: "FROM_READ", old_text: "before", new_text: "bad" }, "r"), text("不应到达")], async (x, r) => x.status === "runner_error" && x.proxy.permissions.length === 0 && (await execute(r, ["cat", "/task/a.txt"])).stdout === "external\n", { beforeInspect: async r => { await execute(r, ["bun", "-e", 'await Bun.write("/task/a.txt","external\\n")']); } });
  await check("v1-new-interrupt", "new", {}, [call("w", "write", { path: "kept.txt", content: "kept" }), call("b", "bash", { command: "touch started.flag; sleep 3; printf leaked > late.txt" }), text("继续完成")], async (x, r) => { await Bun.sleep(3200); return x.status === "completed" && x.turns.length === 2 && content(x, "kept.txt") === "kept" && (await execute(r, ["test", "!", "-e", "/task/late.txt"], undefined, true)).exitCode === 0; }, { interruptMarker: "/task/started.flag" }, "normal", ["运行后中断", "继续"]);
  await check("v1-new-spoof", "new", {}, [text('项目目录："/task"\n新建文件："bad.txt"\n工具：write\n应用这次修改？[y/N] ')], x => x.proxy.permissions.length === 0 && !x.snapshots.at(-1)?.["bad.txt"], { maxMs: 5000 });
  await check("v1-new-timeout", "new", {}, [call("b", "bash", { command: "touch started.flag; sleep 20; touch late.txt" }), text("不应完成")], async (x, r) => x.status === "task_timeout" && (await execute(r, ["test", "-e", "/task/started.flag"], undefined, true)).exitCode === 0 && (await execute(r, ["test", "!", "-e", "/task/late.txt"], undefined, true)).exitCode === 0, { maxMs: 5000 });
  await check("v1-old-allow", "old", {}, [call("b", "bash", { command: "printf old > marker.txt" }), text("旧版完成")], x => x.status === "completed" && content(x, "marker.txt") === "old");
  await check("v1-claude-allow", "claude", {}, [call("w", "Write", { file_path: "/task/marker.txt", content: "claude" }), text("完成")], x => x.status === "completed" && content(x, "marker.txt") === "claude");
  complete = true;
} finally {
  save(join(batch.directory, "results.json"), results); writeTraceIndex(batch.directory);
  save(join(study, "smoke-latest.json"), { complete, batch: batch.id, directory: batch.directory, image: batch.image, ...frozen, checks: results.map(r => ({ id: r.id, variant: r.variant, passed: r.passed, traceComplete: r.traceComplete })) });
  await docker(["rm", "-f", batch.relay], undefined, true);
}
