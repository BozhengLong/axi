import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

async function scenario(mode: "early" | "fresh" | "interrupt") {
  let output = "";
  const decoder = new TextDecoder();
  const directory = mkdtempSync(join(tmpdir(), "axi-terminal-")), trigger = join(directory, "confirm");
  const proc = Bun.spawn([process.execPath, "--no-env-file", resolve("tests/helpers/terminal-input.ts"), mode, trigger], {
    env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
    terminal: { cols: 160, rows: 30, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } },
  });
  const terminal = proc.terminal!;
  async function waitFor(text: string) {
    const until = Date.now() + 2500;
    while (!output.includes(text) && Date.now() < until) await Bun.sleep(5);
    if (!output.includes(text)) throw new Error(`没有收到 ${text}：${JSON.stringify(output)}`);
  }
  try {
    await waitFor(mode === "interrupt" ? "FIRST> " : "READY");
    terminal.write("y\x01");
    await waitFor("\x1b[1D");
    if (mode === "interrupt") { terminal.write("\x03"); await waitFor("ABORTED"); }
    else await Bun.write(trigger, "ready");
    await waitFor("执行这次调用？[y/N] ");
    terminal.write(mode === "fresh" ? "y\r" : "\r");
    if (mode !== "fresh") {
      // 缺陷版本会直接批准，因此同时观察两种结果，避免仅凭超时判断。
      const until = Date.now() + 2500;
      while (!output.includes("拒绝理由") && !output.includes("RESULT=") && Date.now() < until) await Bun.sleep(5);
      if (output.includes("拒绝理由")) terminal.write("\r");
    }
    await waitFor("RESULT=");
    await proc.exited;
    return JSON.parse(output.match(/RESULT=(\{[^\r\n]+\})/)![1]!);
  } finally { proc.kill("SIGKILL"); terminal.close(); await proc.exited; rmSync(directory, { recursive: true, force: true }); }
}

test("R1：提前输入后移到行首，新的确认直接回车仍然拒绝", async () => {
  expect((await scenario("early")).allowed).toBe(false);
});
test("清除残留输入后，新输入 y 仍然可以批准", async () => {
  expect((await scenario("fresh")).allowed).toBe(true);
});
test("中断清除光标两侧输入，下一个确认不会复用 y", async () => {
  expect((await scenario("interrupt")).allowed).toBe(false);
});
