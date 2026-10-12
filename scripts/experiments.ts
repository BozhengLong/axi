import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { APIClient } from "../src/api/client.ts";
import { systemPrompt } from "../src/agent/loop.ts";
import { loadConfig } from "../src/config.ts";
import { SessionLog } from "../src/log.ts";
import type { Effort, Message, ModelResponse, ToolUse } from "../src/api/types.ts";

// 此脚本调用真实模型，但不执行模型提出的任何命令。不会随 bun test 运行。
if (!process.argv.includes("--live")) {
  console.log("运行真实 API 实验：bun run scripts/experiments.ts --live。该脚本不执行 bash。");
  process.exit(0);
}

const config = loadConfig();
const cwd = resolve(".axi/experiments/workspace");
mkdirSync(cwd, { recursive: true });
for (const directory of ["a", "b", "c"]) {
  mkdirSync(`${cwd}/${directory}`, { recursive: true });
  await Bun.write(`${cwd}/${directory}/sample.txt`, "固定实验输入\n");
}
const log = new SessionLog(cwd);
const resultPath = resolve(`.axi/experiments/results-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.json`);
const results: Record<string, unknown>[] = [];

async function request(name: string, messages: Message[], effort: Effort, eager = true): Promise<ModelResponse | undefined> {
  const started = performance.now();
  let firstEventMs: number | undefined;
  let firstToolDeltaMs: number | undefined;
  let lastToolDeltaMs: number | undefined;
  let jsonDeltas = 0;
  let pings = 0;
  const client = new APIClient(config, systemPrompt(cwd), {
    record: (kind, data) => log.record(kind, { experiment: name, ...(data as object) }),
    eagerInputStreaming: eager,
    maxRetries: 0,
    onRawLine(line) {
      if (!line.startsWith("data:")) return;
      const data = JSON.parse(line.slice(5).trim());
      firstEventMs ??= performance.now() - started;
      if (data.type === "ping") pings++;
      if (data.delta?.type === "input_json_delta") {
        firstToolDeltaMs ??= performance.now() - started;
        lastToolDeltaMs = performance.now() - started;
        jsonDeltas++;
      }
    },
  });
  try {
    const response = await client.call(messages, { effort, signal: AbortSignal.timeout(300000) });
    const command = (response.content.find(b => b.type === "tool_use") as ToolUse | undefined)?.input.command;
    const generatedLines = typeof command === "string" ? command.split("\n").filter(line => /^第 \d{3} 行：Axi 流式参数实验$/.test(line)) : [];
    const expectedLines = Array.from({ length: 120 }, (_, i) => `第 ${String(i + 1).padStart(3, "0")} 行：Axi 流式参数实验`);
    const record = { name, effort, eager, status: "completed", durationMs: performance.now() - started, firstEventMs, firstToolDeltaMs, lastToolDeltaMs, jsonDeltas, pings, stopReason: response.stopReason, types: response.content.map(b => b.type), toolCount: response.content.filter(b => b.type === "tool_use").length, ...(name.startsWith("E2") || name.startsWith("D4") ? { proposed120LinesCorrect: JSON.stringify(generatedLines) === JSON.stringify(expectedLines), executed: false } : {}), usage: response.usage };
    results.push(record);
    console.log(JSON.stringify(record));
    return response;
  } catch (error) {
    const record = { name, effort, eager, status: "error", durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
    results.push(record);
    console.log(JSON.stringify(record));
  }
}

try {
  const longTask: Message[] = [{ role: "user", content: "请用一次 bash 调用，以 cat <<'EOF' 的形式创建 long.txt。文件必须含 120 行，逐行写出‘第 001 行：Axi 流式参数实验’至‘第 120 行：Axi 流式参数实验’。不要用循环或代码生成行内容。不要运行文件，不要合并其他操作。" }];
  const eager = await request("E2-eager-on", longTask, "medium", true);
  await request("E2-eager-off", longTask, "medium", false);
  await request("D4-eager-on-high", longTask, "high", true);
  await request("E3-three-directories", [{ role: "user", content: "请同时查看 a、b、c 这三个目录各自的总大小。通过 bash 实际检查。" }], "medium");

  let thinkingResponse = eager?.content.some(b => b.type === "thinking") ? eager : undefined;
  let thinkingTask = longTask;
  if (!thinkingResponse) {
    thinkingTask = [{ role: "user", content: "计划一个可靠的校验：a、b、c 中各有 sample.txt，要检查它们逐字节相同，并报告字节数、SHA-256 和文件个数。请考虑缺文件、空目录和命令失败的情况，然后用一次 bash 调用只读检查。不要修改文件。" }];
    thinkingResponse = await request("E5-prepare", thinkingTask, "high");
  }
  const tools = thinkingResponse?.content.filter(b => b.type === "tool_use") as ToolUse[] | undefined;
  if (thinkingResponse && tools?.length && thinkingResponse.content.some(b => b.type === "thinking")) {
    const history: Message[] = [...thinkingTask, { role: "assistant", content: thinkingResponse.content }, { role: "user", content: tools.map(tool => ({ type: "tool_result", tool_use_id: tool.id, is_error: true, content: "实验模式：命令未执行。用户要求结束实验，只回复‘实验结束’，不要继续调用工具。" })) }];
    await request("E5-intact-control", history, "high");
    const altered = structuredClone(history);
    altered[1]!.content = thinkingResponse.content.filter(b => !["thinking", "redacted_thinking"].includes(b.type));
    await request("E5-omit-thinking", altered, "high");
  } else {
    const record = { name: "E5-omit-thinking", status: "inconclusive", reason: "本次工具响应没有 thinking 块，不能建立删除思考块的负向对照。" };
    results.push(record);
    console.log(JSON.stringify(record));
  }
} finally {
  await Bun.write(resultPath, JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + "\n");
  console.log(`结果已保存：${resultPath}`);
  log.close();
}
