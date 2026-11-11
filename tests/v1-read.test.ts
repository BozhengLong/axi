import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, renameSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileWorkspace } from "../src/tools/files.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { search } from "../src/tools/search.ts";
import { FILE_BYTES } from "../src/tools/common.ts";
import { Agent } from "../src/agent/loop.ts";
import { response, textResponse } from "./fixtures.ts";
import type { ToolUse } from "../src/api/types.ts";

const dirs: string[] = [];
function fixture() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "axi-v1-"))); dirs.push(dir); return dir; }
const signal = () => new AbortController().signal;
const data = (r: { content: string }) => JSON.parse(r.content);
const tool = (id: string, name: string, input: Record<string, unknown>): ToolUse => ({ type: "tool_use", id, name, input });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("F-01：分段原文保留 BOM/CRLF/中文/emoji；全文件版本不随页变化", async () => {
  const d = fixture(), text = "\ufeff第一行🙂\r\n第二行\n最后一行"; writeFileSync(join(d, "a.txt"), text);
  const w = new FileWorkspace(d);
  const a = data(await w.read("a.txt", 1, 1, signal())), b = data(await w.read("a.txt", 2, 200, signal()));
  expect(a.content).toBe("\ufeff第一行🙂\r\n"); expect(a.start_line).toBe(1); expect(a.end_line).toBe(1); expect(a.next_offset).toBe(2); expect(a.truncated).toBe(true);
  expect(b.content).toBe("第二行\n最后一行"); expect(b.version).toBe(a.version); expect(b.end_line).toBe(3); expect(b.next_offset).toBeNull();
  writeFileSync(join(d, "a.txt"), text + "外部变化");
  expect(data(await w.read("a.txt", 1, 1, signal())).version).not.toBe(a.version);
  writeFileSync(join(d, "empty"), ""); expect(data(await w.read("empty", 1, 200, signal())).content).toBe("");
});

test("F-02：拒绝过大、非法 UTF-8、NUL、过长单行；完整行截断不损坏字节", async () => {
  const d = fixture(), w = new FileWorkspace(d);
  for (const [name, content, code] of [["huge", Buffer.alloc(FILE_BYTES + 1), "file_too_large"], ["utf", Buffer.from([0xff]), "unsupported_encoding"], ["nul", "x\0y", "binary_file"], ["line", "🙂".repeat(30001), "line_too_long"]] as const) {
    writeFileSync(join(d, name), content); await expect(w.read(name, 1, 200, signal())).rejects.toHaveProperty("code", code);
  }
  const line = "中".repeat(14999) + "\n"; writeFileSync(join(d, "bounded"), line.repeat(3));
  const r = data(await w.read("bounded", 1, 200, signal())); expect(r.content).toBe(line.repeat(2)); expect(r.next_offset).toBe(3);
});

test("F-02/W-01：读取中增长或改写不能签发旧快照版本", async () => {
  const d = fixture(); writeFileSync(join(d, "a"), "before"); let touched = false;
  const w = new FileWorkspace(d, { checkpoint(phase) { if (phase === "read_chunk" && !touched) { touched = true; writeFileSync(join(d, "a"), "after length changed"); } } });
  await expect(w.read("a", 1, 200, signal())).rejects.toHaveProperty("code", "file_changed");
});

test("P-01/P-03：所有工具共用项目边界及保留名，不能用大小写或相邻前缀绕过", async () => {
  const parent = fixture(), root = join(parent, "project"); mkdirSync(root); mkdirSync(join(parent, "project-other"));
  writeFileSync(join(root, "a"), "ok"); const registry = new ToolRegistry(root);
  for (const path of ["../project-other/a", join(parent, "project-other/a"), "a\0b", "file:///tmp/a", ".git/config", ".GIT/config", ".axi/logs/a", ".ENV", "x/.env.local", "x/secret.KEY", ".ssh/id", ".axi-tmp-owned"]) {
    for (const name of ["read", "glob", "grep"]) await expect(registry.prepare(tool("x", name, { path, ...(name === "read" ? {} : { pattern: "x" }) }), signal())).rejects.toBeInstanceOf(Error);
  }
  const p = await registry.prepare(tool("ok", "read", { path: join(root, "a") }), signal()); expect(data(await p.execute(signal())).content).toBe("ok");
});

test("P-02：符号链接、父链接、断链、硬链接和 FIFO 均不读取", async () => {
  const d = fixture(); writeFileSync(join(d, "a"), "data"); mkdirSync(join(d, "real")); writeFileSync(join(d, "real/x"), "x");
  symlinkSync("a", join(d, "sym")); symlinkSync("real", join(d, "dirlink")); symlinkSync("missing", join(d, "broken"));
  const w = new FileWorkspace(d);
  for (const p of ["sym", "dirlink/x", "broken"]) await expect(w.read(p, 1, 1, signal())).rejects.toHaveProperty("code", "symlink");
  linkSync(join(d, "a"), join(d, "alias")); await expect(w.read("a", 1, 1, signal())).rejects.toHaveProperty("code", "hardlink");
  expect(Bun.spawnSync(["mkfifo", join(d, "pipe")]).exitCode).toBe(0);
  await expect(w.read("pipe", 1, 1, signal())).rejects.toHaveProperty("code", "special_file");
});

test("P-02：根目录身份变化后不能继续访问替代目录", async () => {
  const p = fixture(), d = join(p, "root"); mkdirSync(d); writeFileSync(join(d, "a"), "old");
  const w = new FileWorkspace(d); renameSync(d, join(p, "old")); mkdirSync(d); writeFileSync(join(d, "a"), "replacement");
  await expect(w.read("a", 1, 1, signal())).rejects.toHaveProperty("code", "path_changed");
});

test("F-03/F-04：受控 glob 与字面量 grep；零匹配正常，排除与隐藏普通文件透明", async () => {
  const d = fixture(); mkdirSync(join(d, "src")); mkdirSync(join(d, "node_modules"));
  for (const p of ["z.ts", ".hidden.ts", "src.ts", "src/a.ts", "node_modules/skip.ts"]) writeFileSync(join(d, p), "Needle.*\nneedleZZ\n");
  writeFileSync(join(d, ".env"), "Needle secret"); const w = new FileWorkspace(d);
  const g = data(await search(w, "glob", ".", "**/*.ts", undefined, signal()));
  expect(g.results).toEqual([".hidden.ts", "src.ts", "src/a.ts", "z.ts"]); expect(g.incomplete).toBe(true); expect(g.skipped.blocked_path).toBe(1); expect(g.skipped.excluded_directory).toBe(1);
  const r = data(await search(w, "grep", "src", "Needle.*", "*.ts", signal()));
  expect(r.results).toEqual([{ path: "src/a.ts", line: 1, content: "Needle.*\n" }]); expect(r.incomplete).toBe(false);
  expect(data(await search(w, "grep", "src", "nope", undefined, signal())).results).toEqual([]);
  expect(data(await w.read("node_modules/skip.ts", 1, 200, signal())).content).toContain("Needle");
});

test("F-05：搜索结果、输出和累计字节上限都明确停止", async () => {
  const d = fixture(), w = new FileWorkspace(d);
  writeFileSync(join(d, "lines"), "needle\n".repeat(201));
  const rows = data(await search(w, "grep", "lines", "needle", undefined, signal())); expect(rows.results).toHaveLength(200); expect(rows.code).toBe("result_limit");
  writeFileSync(join(d, "lines"), "needle" + "x".repeat(30000));
  expect(data(await search(w, "grep", "lines", "needle", undefined, signal())).code).toBe("output_limit");
  const sub = join(d, "bytes"); mkdirSync(sub);
  for (let i = 0; i < 33; i++) writeFileSync(join(sub, `${i}.txt`), "x".repeat(FILE_BYTES));
  const r = data(await search(w, "grep", "bytes", "absent", undefined, signal())); expect(r.code).toBe("byte_limit"); expect(r.bytes_read).toBe(32 * FILE_BYTES);
}, 15000);

test("F-05：扫描目录项上限不伪装零匹配成功", async () => {
  const d = fixture(); for (let i = 0; i < 20002; i++) writeFileSync(join(d, `${i}`), "");
  const r = data(await search(new FileWorkspace(d), "glob", ".", "**/*", undefined, signal()));
  expect(r.incomplete).toBe(true); expect(r.code).toBe("entry_limit"); expect(r.visited).toBe(20001);
}, 20000);

test("F-05/I-02：扫描截止和取消可观察；不继续读剩余项目", async () => {
  const d = fixture(); writeFileSync(join(d, "a"), "a"); let first = true;
  const slow = new FileWorkspace(d, { async checkpoint() { if (first) { first = false; await Bun.sleep(5010); } } });
  expect(data(await search(slow, "glob", ".", "**/*", undefined, signal())).code).toBe("time_limit");
  const abort = new AbortController(); const stopped = new FileWorkspace(d, { checkpoint() { abort.abort(); } });
  const r = data(await search(stopped, "glob", ".", "**/*", undefined, abort.signal)); expect(r.status).toBe("cancelled"); expect(r.incomplete).toBe(true);
  await expect(stopped.read("a", 1, 1, signal())).resolves.toBeDefined();
}, 10000);

test("F-08：版本绑定会话、路径和文件模式，并按1000项淘汰", async () => {
  const d = fixture(); const w = new FileWorkspace(d); writeFileSync(join(d, "a"), "a"); writeFileSync(join(d, "b"), "b");
  const a = data(await w.read("a", 1, 1, signal()));
  const snapshot = await w.snapshot("a", signal());
  expect(() => new FileWorkspace(d).requireVersion(snapshot, a.version)).toThrow();
  expect(() => w.requireVersion(snapshot, "invented")).toThrow();
  const other = await w.snapshot("b", signal()); expect(() => w.requireVersion(other, a.version)).toThrow();
  chmodSync(join(d, "a"), 0o755); const changed = await w.snapshot("a", signal()); expect(() => w.requireVersion(changed, a.version)).toThrow();
  const current = data(await w.read("a", 1, 1, signal()));
  for (let i = 0; i < 1000; i++) { writeFileSync(join(d, `x${i}`), ""); await w.read(`x${i}`, 1, 1, signal()); }
  expect(() => w.requireVersion(changed, current.version)).toThrow();
}, 15000);

test("P-04/P-08：project自动读取与strict拒绝；模型参数不能切换权限", async () => {
  const d = fixture(); writeFileSync(join(d, "a"), "data");
  for (const mode of ["project", "strict"] as const) {
    const replies = [response([tool("r", "read", { path: "a" })], "tool_use"), textResponse()]; let approvals = 0; const events: any[] = [];
    const a = new Agent({ cwd: d, call: async () => replies.shift()!, permissionMode: () => mode, approve: async () => { approvals++; return { allowed: false }; }, record: (kind, data) => events.push({ kind, data }) });
    await a.run("read", { signal: signal(), effort: "medium" });
    expect(approvals).toBe(mode === "project" ? 0 : 1);
    const results = a.history[2]!.content as any[];
    expect(results[0].is_error).toBe(mode === "strict");
    expect(events.find(e => e.kind === "permission").data.source).toBe(mode === "project" ? "project_rule" : "user");
  }
  await expect(new ToolRegistry(d).prepare(tool("bad", "read", { path: "a", permissionMode: "project" }), signal())).rejects.toHaveProperty("code", "invalid_input");
});
