import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, chmodSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools/registry.ts";
import { FileWorkspace, type FileHooks } from "../src/tools/files.ts";
import { Agent } from "../src/agent/loop.ts";
import { permissionDisplay, confirmTool } from "../src/ui/permission.ts";
import { visibleText } from "../src/text.ts";
import type { ToolUse, ToolResult } from "../src/api/types.ts";
import { response, textResponse } from "./fixtures.ts";
import { SessionLog } from "../src/log.ts";

const dirs: string[] = [];
const signal = () => new AbortController().signal;
const data = (r: { content: string }) => JSON.parse(r.content);
const tool = (id: string, name: string, input: Record<string, unknown>): ToolUse => ({ type: "tool_use", id, name, input });
function fixture(hooks: FileHooks = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axi-write-"))); dirs.push(root);
  writeFileSync(join(root, "a.txt"), "before\n"); return { root, registry: new ToolRegistry(root, undefined, hooks) };
}
async function edit(registry: ToolRegistry, path = "a.txt", oldText = "before", newText = "after") {
  const read = await registry.prepare(tool("read", "read", { path }), signal()); const version = data(await read.execute(signal())).version;
  return registry.prepare(tool("edit", "edit", { path, base_version: version, old_text: oldText, new_text: newText }), signal());
}
function noTemps(root: string) { expect(readdirSync(root).filter(p => p.startsWith(".axi-tmp-"))).toEqual([]); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("F-06/W-05：真实原子替换保留用户修改、字节和执行位；Git索引不变", async () => {
  const { root, registry } = fixture();
  const git = (args: string[]) => { const r = Bun.spawnSync(["git", "-C", root, ...args]); expect(r.exitCode).toBe(0); return r.stdout.toString(); };
  git(["init", "-q"]); git(["add", "a.txt"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const head = git(["rev-parse", "HEAD"]), index = git(["ls-files", "--stage"]);
  const original = "\ufeff用户已有修改\r\nbefore🙂\r\n尾部"; writeFileSync(join(root, "a.txt"), original); chmodSync(join(root, "a.txt"), 0o755);
  const p = await edit(registry, "a.txt", "before🙂", "after中"); const result = data(await p.execute(signal()));
  expect(result.status).toBe("applied"); expect(result.modified).toBe(true);
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(original.replace("before🙂", "after中"));
  expect(statSync(join(root, "a.txt")).mode & 0o777).toBe(0o755); expect(git(["rev-parse", "HEAD"])).toBe(head); expect(git(["ls-files", "--stage"])).toBe(index); noTemps(root);
});

test("F-07/F-08：零/重叠匹配、空文本、伪造版本和无效Unicode不能修改", async () => {
  const { root, registry } = fixture(); writeFileSync(join(root, "a.txt"), "aaa");
  const version = data(await (await registry.prepare(tool("r", "read", { path: "a.txt" }), signal())).execute(signal())).version;
  for (const [old_text, base_version, code] of [["aa", version, "ambiguous_match"], ["absent", version, "no_match"], ["", version, "invalid_input"], ["aaa", "fake", "stale_version"]]) {
    await expect(registry.prepare(tool("e", "edit", { path: "a.txt", base_version, old_text, new_text: "x" }), signal())).rejects.toHaveProperty("code", code);
  }
  await expect(registry.prepare(tool("w", "write", { path: "new", content: "\ud800" }), signal())).rejects.toHaveProperty("code", "invalid_input");
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("aaa"); noTemps(root);
});

test("F-09/W-03：write独占发布、目标存在/确认后被创建不覆盖，不隐式创建目录", async () => {
  const { root, registry } = fixture();
  await expect(registry.prepare(tool("exists", "write", { path: "a.txt", content: "bad" }), signal())).rejects.toHaveProperty("code", "already_exists");
  await expect(registry.prepare(tool("parent", "write", { path: "missing/x", content: "x" }), signal())).rejects.toHaveProperty("code", "ENOENT");
  const p = await registry.prepare(tool("race", "write", { path: "created", content: "ours" }), signal()); writeFileSync(join(root, "created"), "theirs");
  await expect(p.execute(signal())).rejects.toHaveProperty("code", "already_exists"); expect(readFileSync(join(root, "created"), "utf8")).toBe("theirs");
  const ok = await registry.prepare(tool("new", "write", { path: "new", content: "新文件🙂" }), signal());
  expect(data(await ok.execute(signal())).status).toBe("applied"); expect(readFileSync(join(root, "new"), "utf8")).toBe("新文件🙂"); expect(statSync(join(root, "new")).mode & 0o777).toBe(0o644 & ~process.umask()); noTemps(root);
});

test("P-01/P-02/P-03：write/edit与读取共用保留路径和链接边界", async () => {
  const { root, registry } = fixture(); symlinkSync("a.txt", join(root, "link"));
  for (const path of ["../outside", ".GIT/config", ".ENV", ".axi/logs/x", "link"]) {
    await expect(registry.prepare(tool("w", "write", { path, content: "bad" }), signal())).rejects.toBeInstanceOf(Error);
    await expect(registry.prepare(tool("e", "edit", { path, base_version: "fake", old_text: "x", new_text: "y" }), signal())).rejects.toBeInstanceOf(Error);
  }
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before\n");
});

test("W-01/W-02：读取后/确认期间内容、模式、目标身份变化使旧授权失效", async () => {
  for (const mutate of [(p: string) => writeFileSync(p, "用户新修改"), (p: string) => chmodSync(p, 0o755), (p: string) => { renameSync(p, p + ".old"); writeFileSync(p, "before\n"); }]) {
    const { root, registry } = fixture(), p = await edit(registry); mutate(join(root, "a.txt")); const before = readFileSync(join(root, "a.txt"));
    await expect(p.execute(signal())).rejects.toHaveProperty("code", "stale_version"); expect(readFileSync(join(root, "a.txt"))).toEqual(before); noTemps(root);
  }
  const { root, registry } = fixture();
  const version = data(await (await registry.prepare(tool("r", "read", { path: "a.txt" }), signal())).execute(signal())).version;
  writeFileSync(join(root, "a.txt"), "changed");
  await expect(registry.prepare(tool("e", "edit", { path: "a.txt", base_version: version, old_text: "before", new_text: "x" }), signal())).rejects.toHaveProperty("code", "stale_version");
});

test("W-02：父目录在确认后被替换，不能写到新的同名文件", async () => {
  const { root, registry } = fixture(); mkdirSync(join(root, "sub")); writeFileSync(join(root, "sub/a"), "before"); const p = await edit(registry, "sub/a");
  renameSync(join(root, "sub"), join(root, "old")); mkdirSync(join(root, "sub")); writeFileSync(join(root, "sub/a"), "before");
  await expect(p.execute(signal())).rejects.toHaveProperty("code", "path_changed"); expect(readFileSync(join(root, "sub/a"), "utf8")).toBe("before"); expect(readFileSync(join(root, "old/a"), "utf8")).toBe("before");
});

test("W-04：真实临时文件写入途中注入ENOSPC，原文件保持且临时文件清理", async () => {
  let chunks = 0;
  const { root, registry } = fixture({ checkpoint(phase) { if (phase === "write_chunk" && ++chunks === 2) throw Object.assign(new Error("空间不足"), { code: "ENOSPC" }); } });
  const p = await edit(registry, "a.txt", "before", "中".repeat(24000));
  await expect(p.execute(signal())).rejects.toHaveProperty("code", "ENOSPC"); expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before\n"); noTemps(root);
});

test("W-04/W-06：发布前临时内容被改变，不提交与预览不同的字节", async () => {
  let root = "";
  const f = fixture({ checkpoint(phase) { if (phase === "before_commit") { const temp = readdirSync(root).find(x => x.startsWith(".axi-tmp-"))!; writeFileSync(join(root, temp), "tampered"); } } }); root = f.root;
  const p = await edit(f.registry); await expect(p.execute(signal())).rejects.toHaveProperty("code", "temp_changed"); expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before\n"); noTemps(root);
});

test("W-05：观察者在分块临时写入中只看到旧文件，提交后看到完整新文件", async () => {
  let root = "", observations: string[] = [];
  const f = fixture({ checkpoint(phase) { if (["write_chunk", "after_commit"].includes(phase)) observations.push(readFileSync(join(root, "a.txt"), "utf8")); } }); root = f.root;
  const newText = "中".repeat(24000); await (await edit(f.registry, "a.txt", "before", newText)).execute(signal());
  expect(observations.slice(0, -1)).toEqual(["before\n", "before\n"]); expect(observations.at(-1)).toBe(newText + "\n"); noTemps(root);
});

test("P-07/W-06：预览完整、有界、不可修改；不能重用已执行的提案", async () => {
  const { root, registry } = fixture(); const original = tool("new", "write", { path: "new\nname", content: "one\ntwo" });
  const p = await registry.prepare(original, signal()); original.input.content = "changed after prepare";
  expect(() => { p.preview = "fake"; }).toThrow(); expect(() => { p.tool.input.content = "fake"; }).toThrow();
  const display = permissionDisplay(p.tool, root, p); expect(display).toContain('"new\\nname"'); expect(display).toContain("+one\n+two");
  await p.execute(signal()); expect(readFileSync(join(root, "new\nname"), "utf8")).toBe("one\ntwo");
  await expect(p.execute(signal())).rejects.toHaveProperty("code", "invalid_proposal");
  for (const content of ["x".repeat(30000), "\x1b".repeat(6000)]) await expect(registry.prepare(tool("long", "write", { path: "long", content }), signal())).rejects.toHaveProperty("code", "diff_too_large");
  expect(visibleText("\x1b[2J\u202e")).toBe("\\u001b[2J\\u202e"); noTemps(root);
});

test("I-03/I-04：各个提交前屏障取消都不修改目标，提交后取消保持成功", async () => {
  for (const phase of ["before_temp", "write_chunk", "before_commit", "after_commit"]) {
    const c = new AbortController(); const { root, registry } = fixture({ checkpoint(p) { if (p === phase) c.abort(); } }); const prepared = await edit(registry);
    if (phase === "after_commit") { const r = data(await prepared.execute(c.signal)); expect(r.status).toBe("applied"); expect(r.cancel_requested).toBe(true); expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("after\n"); }
    else { await expect(prepared.execute(c.signal)).rejects.toHaveProperty("name", "AbortError"); expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before\n"); }
    noTemps(root);
  }
});

test("P-05/I-05/I-07：第一项已写入，第二项确认时取消，后续调用补齐且下一轮可继续", async () => {
  for (const mode of ["project", "strict"] as const) {
    const { root } = fixture(), c = new AbortController(); let calls = 0, approvals = 0;
    const a = new Agent({ reviewMode: () => "off", cwd: root, permissionMode: () => mode, call: async () => ++calls === 1 ? response([tool("one", "write", { path: "one", content: "1" }), tool("two", "write", { path: "two", content: "2" }), tool("three", "write", { path: "three", content: "3" })], "tool_use") : textResponse(), approve: async t => { approvals++; if (t.id === "two") c.abort(); return { allowed: true }; } });
    await expect(a.run("任务", { signal: c.signal, effort: "medium" })).rejects.toHaveProperty("name", "AbortError");
    expect(calls).toBe(1); expect(approvals).toBe(2); expect(readFileSync(join(root, "one"), "utf8")).toBe("1"); expect(readdirSync(root).sort()).toEqual(["a.txt", "one"]);
    const rs = a.history[2]!.content as ToolResult[]; expect(rs.map(x => x.is_error)).toEqual([false, true, true]); expect(data(rs[0]!).modified).toBe(true); expect(data(rs[2]!).code).toBe("cancelled_not_started");
    await a.run("继续", { signal: signal(), effort: "medium" }); expect(calls).toBe(2);
  }
});

test("F-10：同批两项使用同一旧版本，第二项必须拒绝且保留第一项", async () => {
  const { root, registry } = fixture(); const version = data(await registry.workspace.read("a.txt", 1, 200, signal())).version;
  const input = { path: "a.txt", base_version: version, old_text: "before", new_text: "after" }; let calls = 0;
  const a = new Agent({ reviewMode: () => "off", cwd: root, registry, call: async () => ++calls === 1 ? response([tool("a", "edit", input), tool("b", "edit", input)], "tool_use") : textResponse(), approve: async () => ({ allowed: true }) });
  await a.run("edit", { signal: signal(), effort: "medium" }); const rs = a.history[2]!.content as ToolResult[];
  expect(data(rs[0]!).status).toBe("applied"); expect(data(rs[1]!).code).toBe("stale_version"); expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("after\n");
});

test("E-02/W-07：提交前日志失败不写入；提交后日志失败保留成功且停止后续模型调用", async () => {
  for (const failure of ["commit_prepared", "commit_result"]) {
    const { root } = fixture(); let calls = 0;
    const a = new Agent({ reviewMode: () => "off", cwd: root, call: async () => { calls++; return response([tool("w", "write", { path: "new", content: "new" }), tool("next", "write", { path: "next", content: "next" })], "tool_use"); }, approve: async () => ({ allowed: true }), record: kind => { if (kind === failure) throw new Error("log failed"); } });
    const notice = await a.run("write", { signal: signal(), effort: "medium" }); expect(notice).toContain("日志写入失败"); expect(calls).toBe(1);
    const rs = a.history[2]!.content as ToolResult[]; expect(data(rs[0]!).modified).toBe(failure === "commit_result"); expect(data(rs[1]!).code).toBe("not_started");
    expect(readdirSync(root).includes("new")).toBe(failure === "commit_result"); expect(readdirSync(root).includes("next")).toBe(false); noTemps(root);
    await expect(a.run("继续", { signal: signal(), effort: "medium" })).rejects.toThrow("日志写入失败");
  }
});

test("W-07/I-08：提交后目标又变化，报告未知状态并停止，不自动重放", async () => {
  let root = ""; const f = fixture({ checkpoint(phase) { if (phase === "after_commit") writeFileSync(join(root, "new"), "external"); } }); root = f.root; let calls = 0;
  const a = new Agent({ reviewMode: () => "off", cwd: root, registry: f.registry, call: async () => { calls++; return response([tool("w", "write", { path: "new", content: "ours" }), tool("next", "write", { path: "next", content: "bad" })], "tool_use"); }, approve: async () => ({ allowed: true }) });
  expect(await a.run("write", { signal: signal(), effort: "medium" })).toContain("状态不确定"); expect(calls).toBe(1);
  expect(data((a.history[2]!.content as ToolResult[])[0]!).status).toBe("unknown"); expect(readFileSync(join(root, "new"), "utf8")).toBe("external"); expect(readdirSync(root).includes("next")).toBe(false);
});

test("P-06/P-09：文件确认默认拒绝并带理由，后续 bash 不自动获批", async () => {
  const { root, registry } = fixture(); const p = await edit(registry); const answers = ["", "保留原文件"]; let output = "";
  const permission = await confirmTool(p.tool, root, p, async prompt => { output += prompt; return answers.shift()!; }, t => output += t, signal()); expect(permission.allowed).toBe(false); expect(permission.reason).toBe("保留原文件"); expect(output).toContain("应用这次修改？[y/N]");
  let calls = 0, approvals = 0; const a = new Agent({ reviewMode: () => "off", cwd: root, call: async () => ++calls === 1 ? response([tool("deny", "write", { path: "new", content: "x" }), tool("bypass", "bash", { command: "touch new" })], "tool_use") : textResponse(), approve: async () => { approvals++; return { allowed: false, reason: "保留原文件" }; } });
  await a.run("task", { signal: signal(), effort: "medium" }); expect(approvals).toBe(2); expect(readdirSync(root).includes("new")).toBe(false);
});

test("E-02：仅在task_end日志失败也提示用户，不谎报所有记录已保存", async () => {
  const { root } = fixture();
  const a = new Agent({ reviewMode: () => "off", cwd: root, call: async () => textResponse(), approve: async () => ({ allowed: true }), record: kind => { if (kind === "task_end") throw new Error("closed log"); } });
  await expect(a.run("hello", { signal: signal(), effort: "medium" })).rejects.toThrow("日志写入失败");
  expect(a.history).toHaveLength(2);
});

test("E-01：日志版本可关联会话；启动时不沿 .axi 链接写到其他目录", () => {
  const { root } = fixture(), outside = fixture().root;
  symlinkSync(outside, join(root, ".axi"));
  expect(() => new SessionLog(root)).toThrow("符号链接"); expect(readdirSync(outside)).toEqual(["a.txt"]);
  const log = new SessionLog(outside); log.record("test", { ok: true }); log.close();
  const entry = JSON.parse(readFileSync(log.path, "utf8")); expect(entry.version).toBe(3); expect(entry.sessionId).toBe(log.id); expect(entry.data).toEqual({ ok: true });
});
