import { readdir, lstat, readFile, writeFile, mkdir, chmod, readlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

// 不沿符号链接收取文件，避免被测产物使控制器读取目录外的内容。
async function snapshot(root: string) {
  const files: Record<string, { type: string; mode: number; data?: string; target?: string }> = {};
  let total = 0;
  async function visit(relative: string) {
    for (const item of await readdir(join(root, relative))) {
      const name = relative ? `${relative}/${item}` : item;
      if ([".axi", ".git", ".claude"].includes(name.split("/")[0]!)) continue;
      if (Object.keys(files).length >= 10000) throw new Error("产物文件数超过上限");
      const path = join(root, name), stat = await lstat(path);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) files[name] = { type: "symlink", mode, target: await readlink(path) };
      else if (stat.isDirectory()) { files[name] = { type: "directory", mode }; await visit(name); }
      else if (stat.isFile()) {
        total += stat.size;
        if (total > 100 * 1024 * 1024) throw new Error("产物超过 100 MiB");
        files[name] = { type: "file", mode, data: (await readFile(path)).toString("base64") };
      } else files[name] = { type: "special", mode };
    }
  }
  await visit(""); return files;
}
if (process.argv[2] === "snapshot") console.log(JSON.stringify(await snapshot("/task")));
else if (process.argv[2] === "logs") {
  const files: Record<string, { data: string; bytes: number }> = {};
  const issues: string[] = [];
  let bytes = 0;
  async function collect(path: string, name: string, recursive: boolean) {
    let stat;
    try { stat = await lstat(path); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return; throw e; }
    if (stat.isSymbolicLink()) { issues.push(`不收取符号链接：${name}`); return; }
    if (stat.isDirectory() && recursive) {
      for (const item of (await readdir(path)).sort()) await collect(join(path, item), `${name}/${item}`, true);
    } else if (stat.isFile() && (name.endsWith(".jsonl") || name === "claude-debug.log")) {
      if (bytes + stat.size > 128 * 1024 * 1024 || Object.keys(files).length >= 1000) { issues.push(`日志收取超限：${name}`); return; }
      bytes += stat.size; files[name] = { data: (await readFile(path)).toString("base64"), bytes: stat.size };
    }
  }
  await collect("/task/.axi/logs", "axi-session", true);
  await collect("/home/eval/.claude/projects", "claude-session", true);
  await collect("/home/eval/claude-debug.log", "claude-debug.log", false);
  console.log(JSON.stringify({ files, issues, bytes }));
}
else if (process.argv[2] === "seed") {
  const files = JSON.parse(await Bun.stdin.text());
  for (const [name, entry] of Object.entries(files) as [string, { data: string; mode?: number }][]) {
    const target = resolve("/task", name);
    if (!target.startsWith("/task/") || name.split("/").includes("..")) throw new Error("种子路径越界");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(entry.data, "base64"));
    await chmod(target, entry.mode ?? 0o644);
  }
}
