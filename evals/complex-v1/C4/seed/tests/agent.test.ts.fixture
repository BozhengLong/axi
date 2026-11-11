import { expect, test } from "bun:test";
import { Agent } from "../src/agent/loop.ts";
import type { ContentBlock, Message, ModelResponse } from "../src/api/types.ts";
import { confirmCommand } from "../src/ui/permission.ts";
import { visibleText } from "../src/ui/terminal.ts";
import { activeSignal, response, textResponse, tool } from "./fixtures.ts";

const success = { content: "退出码：0", isError: false, exitCode: 0, outcome: "completed" as const };
const runOptions = () => ({ effort: "medium" as const, signal: activeSignal() });

test("D3/D5：空输入拒绝，理由可空；非 y 输入不能授权", async () => {
  for (const lines of [["", ""], ["n", "保留原文件"]]) {
    let output = "";
    const answers = [...lines];
    const result = await confirmCommand("line1\nline2", "/test", async () => answers.shift()!, text => output += text, activeSignal());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(lines[1] || undefined);
    expect(output).toContain("line1\nline2");
    expect(output).toContain("/test");
  }
  const answers = ["yes", "Y", "y\ny", "y"];
  expect((await confirmCommand("pwd", "/test", async () => answers.shift()!, () => {}, activeSignal())).allowed).toBe(true);
  expect(answers).toHaveLength(0);
});

test("D1/D4：历史只追加，思考签名不改；本轮 effort 固定，下轮可切换", async () => {
  const calls: { history: readonly Message[]; effort: string }[] = [];
  const thinking: ContentBlock = { type: "thinking", thinking: "摘要", signature: "original-signature" };
  const replies = [response([thinking, tool("one", "pwd")], "tool_use"), textResponse(), textResponse(), textResponse()];
  const agent = new Agent({ cwd: "/test", call: async (history, options) => { calls.push({ history, effort: options.effort }); return replies.shift()!; }, approve: async () => ({ allowed: true }), execute: async () => success });
  const options = runOptions();
  await agent.run("第一个任务", options);
  const previous = agent.history;
  await agent.run("承接上一个任务", { ...options, effort: "high" });
  await agent.run("切回默认", options);
  expect(calls.map(call => call.effort)).toEqual(["medium", "medium", "high", "medium"]);
  expect(agent.history.slice(0, previous.length)).toEqual(previous);
  expect((calls[1]!.history[1]!.content as ContentBlock[])[0]).toEqual(thinking);
  const copy = agent.history;
  copy.length = 0;
  expect(agent.history.length).toBeGreaterThan(0);
});

test("多个工具分别确认；拒绝理由回传；同一条消息返回所有结果", async () => {
  const replies = [response([tool("one", "touch original"), tool("two", "pwd")], "tool_use"), textResponse()];
  const approvals: string[] = [];
  const executed: string[] = [];
  const agent = new Agent({ cwd: "/test", call: async () => replies.shift()!, approve: async call => {
    approvals.push(call.id);
    return call.id === "one" ? { allowed: false, reason: "保留原文件，另存为新文件" } : { allowed: true };
  }, execute: async input => { executed.push(input.command); return success; } });
  await agent.run("执行任务", runOptions());
  expect(approvals).toEqual(["one", "two"]);
  expect(executed).toEqual(["pwd"]);
  const results = agent.history[2]!.content as ContentBlock[];
  expect(results).toHaveLength(2);
  expect(results.map(r => r.tool_use_id)).toEqual(["one", "two"]);
  expect(results[0]!.content).toContain("保留原文件");
  expect(results[0]!.is_error).toBe(true);
});

test("在第二次确认时中断，补齐全部结果；下轮可继续", async () => {
  const controller = new AbortController();
  let calls = 0;
  let executed = 0;
  const agent = new Agent({ cwd: "/test", call: async () => ++calls === 1 ? response([tool("a", "pwd"), tool("b", "pwd"), tool("c", "pwd")], "tool_use") : textResponse(),
    approve: async tool => { if (tool.id === "b") controller.abort(); return { allowed: true }; }, execute: async () => { executed++; return success; } });
  await expect(agent.run("任务", { effort: "medium", signal: controller.signal })).rejects.toThrow();
  expect(executed).toBe(1);
  const results = agent.history[2]!.content as ContentBlock[];
  expect(results.map(result => result.tool_use_id)).toEqual(["a", "b", "c"]);
  expect(results.map(result => result.is_error)).toEqual([false, true, true]);
  await agent.run("继续", runOptions());
  expect(calls).toBe(2);
});

test("API 失败不会追加半截 assistant；未知工具与截断工具不能执行", async () => {
  const agent = new Agent({ cwd: "/test", call: async () => { throw new Error("broken stream"); }, approve: async () => { throw new Error("不应调用"); } });
  await expect(agent.run("任务", runOptions())).rejects.toThrow("broken stream");
  expect(agent.history).toEqual([{ role: "user", content: "任务" }]);
  for (const reply of [response([{ ...tool("x", "pwd"), name: "unknown" }], "tool_use"), response([tool("x", "pwd")], "max_tokens")]) {
    const replies = [reply, textResponse()];
    const next = new Agent({ cwd: "/test", call: async () => replies.shift()!, approve: async () => { throw new Error("不应调用"); } });
    await next.run("任务", runOptions());
    expect((next.history[2]!.content as ContentBlock[])[0]!.is_error).toBe(true);
  }
});

test("工具失败仍返回结果；调用上限保留完整历史", async () => {
  let calls = 0;
  const agent = new Agent({ cwd: "/test", maxCalls: 2, call: async () => response([tool(`call-${++calls}`, "pwd")], "tool_use"), approve: async () => ({ allowed: true }), execute: async () => { throw new Error("无法启动"); } });
  expect(await agent.run("任务", runOptions())).toContain("2 次");
  expect(calls).toBe(2);
  expect((agent.history.at(-1)!.content as ContentBlock[])[0]!.content).toContain("无法启动");
});

test("终端显示不能执行 ANSI、回车覆盖或双向文本控制", () => {
  const text = "printf ok\x1b[2J\r\u202e danger";
  const visible = visibleText(text);
  expect(visible).toContain("\\u001b[2J");
  expect(visible).toContain("\\u000d");
  expect(visible).toContain("\\u202e");
});
