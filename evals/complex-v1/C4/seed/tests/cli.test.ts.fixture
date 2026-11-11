import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { streamFixture, tool } from "./fixtures.ts";

test("真实 CLI + 本地 HTTP：多轮、逐次确认、跳过理由、effort 切换、中断后继续", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "axi-cli-"));
  const requests: any[] = [];
  const replies = [
    streamFixture([{ type: "thinking", thinking: "检查授权。", signature: "local-signature" }, tool("denied", "touch denied.txt")], "tool_use"),
    streamFixture([{ type: "text", text: "第一轮完成" }]),
    streamFixture([tool("approved", "printf created > created.txt"), tool("denied2", "touch denied2.txt")], "tool_use"),
    streamFixture([{ type: "text", text: "第二轮完成" }]),
    streamFixture([tool("interrupted", "sleep 10; touch interrupted.txt")], "tool_use"),
    streamFixture([{ type: "text", text: "中断后可以继续" }]),
  ];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests.push(await req.json());
    return new Response(replies[requests.length - 1] ?? "unexpected", { headers: { "content-type": "text/event-stream" } });
  } });
  const env = { ...process.env };
  // 本地模拟服务不经过开发机器的外部代理。
  for (const key of Object.keys(env)) if (/^(http|https|all|no)_proxy$/i.test(key)) delete env[key];
  const child = Bun.spawn([process.execPath, resolve("src/main.ts")], {
    cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "local-fake", NO_COLOR: "1" },
  });
  let output = "";
  const read = (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true }); })();
  const stderr = new Response(child.stderr).text();
  let cursor = 0;
  async function waitFor(text: string) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const index = output.indexOf(text, cursor);
      if (index >= 0) { cursor = index + text.length; return; }
      await Bun.sleep(5);
    }
    throw new Error(`没有看到 ${text}。输出：${output}`);
  }
  async function send(text: string) { child.stdin.write(text + "\n"); await child.stdin.flush(); }
  try {
    await waitFor("你 [medium] > ");
    await send("第一轮\ny"); // 提前粘贴的 y 不能批准稍后出现的调用。
    await waitFor("执行这次调用？[y/N] ");
    expect(output).toContain("思考摘要：");
    expect(await Bun.file(join(cwd, "denied.txt")).exists()).toBe(false);
    await send("n"); await waitFor("拒绝理由（选填，回车跳过）：");
    await send("保留原文件"); await waitFor("你 [medium] > ");
    expect(requests[1].messages[2].content[0].content).toContain("保留原文件");
    await send("/effort high"); await waitFor("你 [high] > ");
    await send("第二轮"); await waitFor("执行这次调用？[y/N] ");
    await send("y"); await waitFor("执行这次调用？[y/N] ");
    await send(""); await waitFor("拒绝理由（选填，回车跳过）：");
    await send(""); await waitFor("你 [high] > ");
    expect(await Bun.file(join(cwd, "created.txt")).text()).toBe("created");
    expect(await Bun.file(join(cwd, "denied2.txt")).exists()).toBe(false);
    expect(requests[2].output_config.effort).toBe("high");
    expect(requests[3].output_config.effort).toBe("high");
    const results = requests[3].messages.at(-1).content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(["approved", "denied2"]);
    await send("/effort medium"); await waitFor("你 [medium] > ");
    await send("中断任务"); await waitFor("执行这次调用？[y/N] ");
    await send("y");
    await Bun.sleep(100);
    child.kill("SIGINT");
    await waitFor("已中止。"); await waitFor("你 [medium] > ");
    await send("继续"); await waitFor("中断后可以继续"); await waitFor("你 [medium] > ");
    expect(requests[5].output_config.effort).toBe("medium");
    const interrupted = requests[5].messages.find((message: any) => Array.isArray(message.content) && message.content.some((b: any) => b.tool_use_id === "interrupted"));
    expect(interrupted.content[0].is_error).toBe(true);
    expect(await Bun.file(join(cwd, "interrupted.txt")).exists()).toBe(false);
    expect(await Bun.file(join(cwd, "denied.txt")).exists()).toBe(false);
    await send("/exit");
    expect(await child.exited).toBe(0);
    await read;
    expect(await stderr).toBe("");
    expect(requests).toHaveLength(6);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);
