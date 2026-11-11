import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

test("R3：外部 Git 仓库的子目录日志被忽略，不改根忽略规则", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-log-git-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "existing-rule\n");
    const cwd = join(root, "nested"); mkdirSync(cwd);
    const log = new SessionLog(cwd); log.record("request", { content: "synthetic" }); log.close();
    const ignored = Bun.spawnSync(["git", "-C", root, "check-ignore", log.path]);
    expect(ignored.exitCode).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("existing-rule\n");
    const status = Bun.spawnSync(["git", "-C", root, "status", "--short", "--untracked-files=all"]);
    expect(status.stdout.toString()).not.toContain(".axi/");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("日志排除规则保留旧内容，重复启动不重复追加", () => {
  const cwd = mkdtempSync(join(tmpdir(), "axi-log-ignore-"));
  try {
    const dir = join(cwd, ".axi", "logs"); mkdirSync(dir, { recursive: true });
    const path = join(dir, ".gitignore"); writeFileSync(path, "# existing\n!keep.jsonl");
    const first = new SessionLog(cwd); first.close();
    const once = readFileSync(path, "utf8");
    const second = new SessionLog(cwd); second.close();
    expect(once).toStartWith("# existing\n!keep.jsonl\n");
    expect(once.trimEnd().split("\n").at(-1)).toBe("*");
    expect(readFileSync(path, "utf8")).toBe(once);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
