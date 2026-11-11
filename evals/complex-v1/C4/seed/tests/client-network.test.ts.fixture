import { expect, test } from "bun:test";
import { resolve } from "node:path";

async function realFailure(mode: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(http|https|all|no)_proxy$/i.test(key)) delete env[key];
  const proc = Bun.spawn([process.execPath, "--no-env-file", resolve("tests/helpers/network-retry.ts"), mode], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0); expect(stderr).toBe("");
  return JSON.parse(stdout);
}
test("R2：真实连接拒绝最多发送四次请求", async () => {
  const r = await realFailure("refuse");
  expect(r.calls).toBe(4);
  expect(r.delays).toEqual([1000, 2000, 4000]);
  expect(r.complete).toBe(false);
});
test("真实连接拒绝后服务恢复，下一次重试成功", async () => {
  const r = await realFailure("recover");
  expect(r.calls).toBe(2);
  expect(r.delays).toEqual([1000]);
  expect(r.complete).toBe(true);
});
