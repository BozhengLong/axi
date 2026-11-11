import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// 只在独立源码副本植入错误，不改被测工作区，不使用真实模型。
const root = resolve(import.meta.dir, ".."), study = join(homedir(), ".local/share/axi-evals/v1-20261112");
const directory = join(study, `mutation-${Date.now()}`); mkdirSync(directory, { recursive: true, mode: 0o700 });
const listing = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root });
if (listing.exitCode) throw new Error("无法枚举源码");
const paths = listing.stdout.toString().split("\0").filter(p => p.startsWith("src/") || p.startsWith("tests/") || ["package.json", "bun.lock", "tsconfig.json"].includes(p));
const source = Object.fromEntries(paths.map(p => [p, readFileSync(join(root, p))]));
const hashes = Object.fromEntries(paths.map(p => [p, createHash("sha256").update(source[p]!).digest("hex")]));
const edits = (text: string, from: string, to: string) => {
  if (text.split(from).length !== 2) throw new Error("变体目标不是唯一匹配：" + from.slice(0, 80));
  return text.replace(from, to);
};
type Case = { id: string; file: string; name: string; target: string; change?: (text: string) => string };
const cases: Case[] = [
  { id: "baseline", file: "", name: "v1-(read|write)", target: "" },
  { id: "replace-many", file: "src/tools/files.ts", name: "F-07/F-08", target: "F-07/F-08", change: text => edits(edits(text,
    '    if (before.text.indexOf(oldText, at + 1) >= 0) throw new ToolError("ambiguous_match", "old_text 出现多次（含重叠），不能猜测替换位置。");', ""),
    'before.text.slice(0, at) + newText + before.text.slice(at + oldText.length)', 'before.text.split(oldText).join(newText)') },
  { id: "skip-recheck", file: "src/tools/files.ts", name: "W-01/W-02", target: "W-01/W-02", change: text => edits(text,
    '        if (this.fingerprint(now) !== this.fingerprint(state.before)) throw new ToolError("stale_version", "文件在确认期间变化。请重新 read、提出修改并确认。");', "") },
  { id: "overwrite-create", file: "src/tools/files.ts", name: "F-09/W-03", target: "F-09/W-03", change: text => edits(edits(edits(text,
    '    if (target.stat) throw new ToolError("already_exists", "write 只创建新文件，不能覆盖已有目标。已有文件请先 read 再 edit。");', ""),
    '      } else if (current.stat) throw new ToolError("already_exists", "确认期间目标已被创建，没有覆盖。");', '      }'),
    'else linkSync(temp, state.path.absolute);', 'else renameSync(temp, state.path.absolute);') },
  { id: "prefix-only", file: "src/tools/paths.ts", name: "P-01/P-03", target: "P-01/P-03", change: text => edits(text,
    'rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)', '!absolute.startsWith(this.root)') },
  { id: "ignore-cancel", file: "src/agent/loop.ts", name: "P-05/I-05/I-07", target: "P-05/I-05/I-07", change: text => text.replaceAll('options.signal', '(new AbortController().signal)') },
  { id: "lie-after-commit", file: "src/tools/files.ts", name: "I-03/I-04", target: "I-03/I-04", change: text => edits(text,
    '        const version = this.remember(now);', '        const version = this.remember(now);\n        if (signal.aborted) return result(proposal.operation, proposal.path, { status: "cancelled", modified: false }, true);') },
];
const results: any[] = [];
for (const c of cases) {
  const dir = join(directory, c.id); mkdirSync(dir, { mode: 0o700 });
  for (const path of paths) { const dest = join(dir, path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, source[path]!); }
  if (c.change) writeFileSync(join(dir, c.file), c.change(source[c.file]!.toString()));
  const args = [process.execPath, "test", "tests/v1-read.test.ts", "tests/v1-write.test.ts", ...(c.change ? ["--test-name-pattern", c.name] : [])];
  const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "mutation-fake" } });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); clearTimeout(timer);
  const passed = c.change ? exitCode !== 0 && stderr.includes(`(fail) ${c.target}`) && !/SyntaxError|Cannot find module|Unexpected token/.test(stderr) : exitCode === 0;
  const entry = { id: c.id, passed, exitCode, args, stdout, stderr };
  results.push(entry); writeFileSync(join(dir, "result.json"), JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ id: c.id, passed, exitCode }));
  if (!passed) break;
}
const report = { complete: results.length === cases.length && results.every(r => r.passed), directory, hashes, results };
writeFileSync(join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
writeFileSync(join(study, "mutations-latest.json"), JSON.stringify({ directory, complete: report.complete }, null, 2) + "\n", { mode: 0o600 });
if (!report.complete) process.exitCode = 1;
