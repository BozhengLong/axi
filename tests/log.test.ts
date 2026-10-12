import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog } from "../src/log.ts";

test("日志逐行带时间戳，使用私有文件权限，每次运行创建新文件", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "axi-log-"));
  try {
    const first = new SessionLog(cwd);
    const second = new SessionLog(cwd);
    first.record("sse", { line: "data: 中文" });
    first.record("permission", { allowed: false });
    first.close(); second.close();
    const lines = (await Bun.file(first.path).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].data.line).toBe("data: 中文");
    expect(Number.isNaN(Date.parse(lines[0].time))).toBe(false);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(first.path).not.toBe(second.path);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
