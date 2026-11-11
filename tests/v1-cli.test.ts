import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { streamFixture } from "./fixtures.ts";
import type { ToolUse } from "../src/api/types.ts";

const tool = (id: string, name: string, input: Record<string, unknown>): ToolUse => ({ type: "tool_use", id, name, input });

test("v1真实CLI/PTY：自动读取、固定差异、冲突拒绝、strict、创建、中断及继续", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "axi-v1-cli-")));
  writeFileSync(join(cwd, "a.txt"), "before\n"); writeFileSync(join(cwd, "user.txt"), "keep\n");
  const requests: any[] = [], checks: string[] = [];
  const shell = '(while [ ! -e release.txt ]; do sleep 0.02; done; printf leaked > late.txt) & printf "%s" $! > child.pid; printf ready > running.txt; wait';
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: any = await req.json(); requests.push(body);
    const last = body.messages.at(-1)?.content;
    let wire: string;
    switch (requests.length) {
      case 1:
        if (["bash", "read", "glob", "grep", "write", "edit"].every(name => body.tools.some((t: any) => t.name === name))) checks.push("six-tools");
        wire = streamFixture([tool("r0", "read", { path: "a.txt" })], "tool_use"); break;
      case 2: {
        const read = JSON.parse(last[0].content);
        if (read.content === "before\n" && read.version) checks.push("read-original");
        wire = streamFixture([tool("e0", "edit", { path: "a.txt", base_version: read.version, old_text: "before", new_text: "after" }), tool("w0", "write", { path: "denied.txt", content: "should not exist\n" })], "tool_use"); break;
      }
      case 3:
        if (JSON.parse(last[0].content).code === "stale_version" && JSON.parse(last[1].content).code === "user_denied") checks.push("conflict-and-denial");
        wire = streamFixture([{ type: "text", text: "冲突已记录" }]); break;
      case 4: wire = streamFixture([tool("strict", "read", { path: "a.txt" })], "tool_use"); break;
      case 5:
        if (JSON.parse(last[0].content).content === "external\n") checks.push("strict-read");
        wire = streamFixture([{ type: "text", text: "只读完成" }]); break;
      case 6: wire = streamFixture([tool("w1", "write", { path: "new.txt", content: "created\n" })], "tool_use"); break;
      case 7:
        if (JSON.parse(last[0].content).status === "applied") checks.push("write-applied");
        wire = streamFixture([tool("b1", "bash", { command: shell })], "tool_use"); break;
      case 8: {
        const interrupted = body.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "b1"));
        if (interrupted?.content[0]?.is_error) checks.push("cancel-paired");
        wire = streamFixture([{ type: "text", text: "取消后继续完成" }]); break;
      }
      default: wire = streamFixture([{ type: "text", text: "unexpected" }]);
    }
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  } });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(http|https|all|no)_proxy$/i.test(k)) delete env[k];
  let output = ""; const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, resolve("src/main.ts")], { cwd, env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "v1-local-fake", NO_COLOR: "1", TERM: "xterm-256color" }, terminal: { cols: 160, rows: 40, data(_term, bytes) { output += decoder.decode(bytes, { stream: true }); } } });
  const term = child.terminal!; let cursor = 0;
  const clean = () => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "");
  async function waitFor(text: string) {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const value = clean(), at = value.indexOf(text, cursor);
      if (at >= 0) { cursor = at + text.length; return; }
      await Bun.sleep(5);
    }
    throw new Error(`未看到 ${text}，输出尾部：${clean().slice(-2000)}`);
  }
  const send = (text: string) => term.write(text + "\n");
  try {
    await waitFor("你 [medium] > "); send("任务A\ny");
    await waitFor("应用这次修改？[y/N] ");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before\n"); // 提前 y 没有授权。
    expect(clean()).toContain("-before\n+after\n");
    writeFileSync(join(cwd, "a.txt"), "external\n"); send("y");
    await waitFor("应用这次修改？[y/N] "); send("n"); await waitFor("拒绝理由（选填，回车跳过）："); send("保留已有工作");
    await waitFor("冲突已记录"); await waitFor("你 [medium] > ");
    expect(existsSync(join(cwd, "denied.txt"))).toBe(false); expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("external\n");
    send("/permissions strict"); await waitFor("权限模式：strict"); await waitFor("你 [medium] > "); send("只读");
    await waitFor("执行这次读取？[y/N] "); send("y"); await waitFor("只读完成"); await waitFor("你 [medium] > ");
    send("/permissions project"); await waitFor("权限模式：project"); await waitFor("你 [medium] > "); send("创建并运行");
    await waitFor("应用这次修改？[y/N] "); expect(clean()).toContain("新建文件：\"new.txt\""); send("y");
    await waitFor("执行这次调用？[y/N] "); send("y");
    const deadline = Date.now() + 5000;
    while (!existsSync(join(cwd, "running.txt")) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(join(cwd, "child.pid"))).toBe(true);
    term.write("\x03"); await waitFor("已中止。"); await waitFor("你 [medium] > ");
    expect(clean()).toContain('已完成的文件修改："new.txt"'); expect(requests).toHaveLength(7);
    writeFileSync(join(cwd, "release.txt"), "release"); await Bun.sleep(150);
    expect(existsSync(join(cwd, "late.txt"))).toBe(false); expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("created\n");
    send("继续"); await waitFor("取消后继续完成"); await waitFor("你 [medium] > "); send("/exit");
    expect(await child.exited).toBe(0); expect(checks).toEqual(["six-tools", "read-original", "conflict-and-denial", "strict-read", "write-applied", "cancel-paired"]); expect(requests).toHaveLength(8);
    expect(readFileSync(join(cwd, "user.txt"), "utf8")).toBe("keep\n");
    const logFile = readdirSync(join(cwd, ".axi/logs")).find(p => p.endsWith(".jsonl"))!;
    const events = readFileSync(join(cwd, ".axi/logs", logFile), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(events.some(e => e.kind === "permission" && e.data.source === "project_rule")).toBe(true);
    expect(events.filter(e => e.kind === "permission_request")).toHaveLength(5);
    expect(events.some(e => e.kind === "commit_result" && e.data.status === "applied")).toBe(true);
    expect(events.some(e => e.kind === "cancel_requested")).toBe(true);
  } finally {
    child.kill("SIGKILL"); await child.exited; term.close(); server.stop(true); rmSync(cwd, { recursive: true, force: true });
  }
}, 20000);
