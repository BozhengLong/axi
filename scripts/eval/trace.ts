import { appendFileSync, readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, relative } from "node:path";
import { execute, save, current, type Batch, type Runtime } from "./core.ts";

export class IOTrace {
  readonly path: string;
  private started = performance.now();
  private total = 0;
  truncated = false;
  constructor(directory: string, agent: string, args: string[]) {
    this.path = join(directory, "io.jsonl");
    this.event("start", { agent, args, version: 2 });
  }
  event(kind: string, data: unknown): void {
    if (this.truncated) return;
    const line = JSON.stringify({ time: new Date().toISOString(), elapsedMs: performance.now() - this.started, kind, data }) + "\n";
    if (this.total + Buffer.byteLength(line) > 200 * 1024 * 1024) {
      this.truncated = true;
      appendFileSync(this.path, JSON.stringify({ time: new Date().toISOString(), kind: "truncated", data: { reason: "IO trace 超过 200 MiB" } }) + "\n", { mode: 0o600 });
      return;
    }
    this.total += Buffer.byteLength(line); appendFileSync(this.path, line, { mode: 0o600 });
  }
  bytes(kind: string, bytes: Uint8Array | string): void {
    const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    this.event(kind, { encoding: "base64", bytes: buffer.byteLength, data: buffer.toString("base64") });
  }
}

export async function collectNativeTrace(runtime: Runtime): Promise<void> {
  const root = join(runtime.directory, "native"); mkdirSync(root, { mode: 0o700, recursive: true });
  try {
    const exported = JSON.parse((await execute(runtime, ["bun", "/opt/eval/files.ts", "logs"])).stdout);
    const entries: { path: string; bytes: number; sha256: string }[] = [];
    for (const [name, item] of Object.entries(exported.files) as [string, { data: string; bytes: number }][]) {
      const path = resolve(root, name);
      if (!path.startsWith(root + "/") || name.split("/").includes("..")) throw new Error("原生日志路径越界");
      const bytes = Buffer.from(item.data, "base64");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600 }); chmodSync(path, 0o600);
      if (name.endsWith(".jsonl")) {
        try { for (const line of bytes.toString("utf8").split("\n")) if (line.trim()) JSON.parse(line); }
        catch { exported.issues.push(`原生日志存在不完整 JSON 行：${name}`); }
      }
      entries.push({ path: name, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    save(join(root, "manifest.json"), { status: exported.issues.length ? "partial" : "collected", issues: exported.issues, files: entries });
  } catch (error) { save(join(root, "manifest.json"), { status: "failed", issues: [String(error)], files: [] }); }
}

export function finalizeTrace(batch: Batch, runtime: Runtime) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  function walk(directory: string) {
    for (const item of readdirSync(directory)) {
      if (directory === runtime.directory && ["trace-manifest.json", "TRACE.md"].includes(item)) continue;
      const path = join(directory, item), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: relative(runtime.directory, path), bytes: stat.size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  }
  walk(runtime.directory);
  const relayPath = join(batch.directory, "relay", `${runtime.id}.jsonl`);
  if (existsSync(relayPath)) files.push({ path: `../relay/${runtime.id}.jsonl`, bytes: lstatSync(relayPath).size, sha256: createHash("sha256").update(readFileSync(relayPath)).digest("hex") });
  const nativePath = join(runtime.directory, "native/manifest.json");
  const native = existsSync(nativePath) ? JSON.parse(readFileSync(nativePath, "utf8")) : { status: "missing", files: [] };
  const ioPath = join(runtime.directory, "io.jsonl");
  const io = existsSync(ioPath) ? readFileSync(ioPath, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const agent = io.find(e => e.kind === "start")?.data?.agent;
  const expectedNative = agent === "axi" ? native.files.some((f: any) => f.path.startsWith("axi-session/")) : native.files.some((f: any) => f.path.startsWith("claude-session/"));
  const missing: string[] = [];
  if (!io.length) missing.push("IO 时间线");
  if (!io.some(e => e.kind === "finish")) missing.push("进程结束记录");
  if (!existsSync(relayPath)) missing.push("API 事件");
  if (native.status !== "collected" || !expectedNative) missing.push("原生会话日志");
  if (agent === "claude" && !existsSync(join(runtime.directory, "stderr.txt"))) missing.push("stderr");
  if (agent === "claude" && !native.files.some((f: any) => f.path === "claude-debug.log")) missing.push("Claude Code debug 日志");
  if (io.some(e => e.kind === "truncated")) missing.push("IO 超限截断");
  if (io.some(e => e.kind === "stderr_read_error")) missing.push("stderr 读取错误");
  if (existsSync(relayPath) && readFileSync(relayPath, "utf8").split("\n").some(l => l && JSON.parse(l).kind === "truncated")) missing.push("API 超限截断");
  const summary = { version: 2, run: runtime.id, agent, status: missing.length ? "partial" : "complete_observable", missing, files };
  save(join(runtime.directory, "trace-manifest.json"), summary);
  const lines = [`# ${runtime.id} 运行轨迹`, "", `状态：${summary.status}。${missing.length ? `缺口：${missing.join("、")}。` : "已收齐本方案约定的可观察记录。"}`, "", "这里不包含服务端未返回的内部推理，认证头也不保留。工具自身的截断仍适用。", "", "| 文件 | 字节数 |", "|---|---:|", ...files.map(f => `| [${f.path}](${f.path}) | ${f.bytes} |`)];
  writeFileSync(join(runtime.directory, "TRACE.md"), lines.join("\n") + "\n", { mode: 0o600 });
  return summary;
}

export function writeTraceIndex(directory: string): string {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const results = JSON.parse(readFileSync(join(directory, "results.json"), "utf8"));
  const lines = [`# ${manifest.batch} Trace 索引`, "", `记录版本：${manifest.traceVersion ?? 1}。原始记录在本机私有目录保存，清理测试容器不会删除这些文件。`, "",
    manifest.traceVersion === 2 ? "每轮清单标记是否收齐约定的可观察记录，并记录 SHA-256。API 返回的摘要保留；未返回的内部推理无法取得。" : "此批已有 API 事件、CLI 输出、权限、快照和验收结果；原生容器日志及独立 stderr 当时未完整归档，不能事后补回。",
    "", "[任务、配置与源码哈希](manifest.json) · [结果总表](results.json)", "", "| 任务 | 次数 | 工具 | API 事件 | CLI 输出 | 执行与快照 | 完整性清单 |", "|---|---:|---|---|---|---|---|"];
  for (const r of [...results].sort((a, b) => a.task.localeCompare(b.task) || a.repeat - b.repeat || a.agent.localeCompare(b.agent))) {
    const cli = r.agent === "axi" ? "terminal.txt" : "claude.jsonl";
    const trace = join(directory, r.id, "trace-manifest.json");
    const status = existsSync(trace) ? JSON.parse(readFileSync(trace, "utf8")).status : "旧版记录存在已知缺口";
    lines.push(`| ${r.task} | ${r.repeat} | ${r.agent} | [JSONL](relay/${r.id}.jsonl) | [输出](${r.id}/${cli}) | [执行](${r.id}/execution.json) / [文件](${r.id}/final-files.json) | ${existsSync(trace) ? `[${status}](${r.id}/TRACE.md)` : status} |`);
  }
  lines.push("", "这些文件可能含任务和文件内容，请使用脱敏报告对外共享。网络分片和服务端内部状态不属于可恢复记录。");
  const path = join(directory, "TRACE-INDEX.md"); writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 }); return path;
}

if (import.meta.main) console.log(writeTraceIndex(process.argv[2] ?? current().directory));
