import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedOutput, parseBashInput, runBash } from "../src/tools/bash.ts";
import { activeSignal } from "./fixtures.ts";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "axi-test-")); directories.push(path); return path; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("bash 合并输出、返回退出码，下一次不沿用 cwd 或 export", async () => {
  const cwd = directory();
  const result = await runBash({ command: "printf '标准输出'; printf '标准错误' >&2; exit 7", timeoutMs: 1000 }, cwd, activeSignal());
  expect(result.isError).toBe(true);
  expect(result.exitCode).toBe(7);
  expect(result.content).toContain("标准输出");
  expect(result.content).toContain("标准错误");
  await runBash({ command: "cd /; export AXI_TEST_ONLY=yes", timeoutMs: 1000 }, cwd, activeSignal());
  const second = await runBash({ command: "printf '%s|%s' \"$PWD\" \"${AXI_TEST_ONLY-unset}\"", timeoutMs: 1000 }, cwd, activeSignal());
  expect(second.content).toContain(`${cwd}|unset`);
});

test("stdout 大量输出时只保留头尾，按 Unicode 字符截断", async () => {
  const buffer = new BoundedOutput(10);
  buffer.append("🙂".repeat(6)); buffer.append("中".repeat(6));
  expect(buffer.toString()).toBe("🙂".repeat(5) + "\n[省略 2 字符]\n" + "中".repeat(5));
  const result = await runBash({ command: "printf 'HEAD'; head -c 1000000 /dev/zero | tr '\\0' x; printf 'TAIL'", timeoutMs: 5000 }, directory(), activeSignal());
  expect(result.content).toContain("HEAD");
  expect(result.content).toContain("TAIL");
  expect(result.content).toContain("[省略 970008 字符]");
  expect(result.content.length).toBeLessThan(30100);
});

test("超时杀掉整个进程组，子进程不能延迟写文件", async () => {
  const cwd = directory();
  const result = await runBash({ command: "(sleep 0.35; printf leaked > late.txt) & wait", timeoutMs: 50 }, cwd, activeSignal());
  expect(result.outcome).toBe("timeout");
  await Bun.sleep(450);
  expect(await Bun.file(join(cwd, "late.txt")).exists()).toBe(false);
});

test("中断命令和未开始的命令均不会继续写文件", async () => {
  const cwd = directory();
  const controller = new AbortController();
  const pending = runBash({ command: "(sleep 0.35; printf leaked > late.txt) & wait", timeoutMs: 3000 }, cwd, controller.signal);
  setTimeout(() => controller.abort(), 40);
  expect((await pending).outcome).toBe("cancelled");
  expect((await runBash({ command: "touch immediate.txt", timeoutMs: 1000 }, cwd, controller.signal)).outcome).toBe("cancelled");
  await Bun.sleep(450);
  expect(await Bun.file(join(cwd, "late.txt")).exists()).toBe(false);
  expect(await Bun.file(join(cwd, "immediate.txt")).exists()).toBe(false);
});

test("禁止后台残留，stdin 关闭，参数验证不宽松放行", async () => {
  const cwd = directory();
  const start = performance.now();
  await runBash({ command: "(sleep 1; touch late.txt) >/dev/null 2>&1 &", timeoutMs: 3000 }, cwd, activeSignal());
  expect(performance.now() - start).toBeLessThan(1500);
  const result = await runBash({ command: "read value; printf 'EOF:%s' $?", timeoutMs: 1000 }, cwd, activeSignal());
  expect(result.content).toContain("EOF:1");
  expect(() => parseBashInput({ command: "pwd", timeout_ms: -1 })).toThrow();
  expect(() => parseBashInput({ command: "pwd", extra: true })).toThrow();
  expect(() => parseBashInput({ command: "\0" })).toThrow();
});
