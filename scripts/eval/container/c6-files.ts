import { readdir, lstat, readFile, writeFile, mkdir, chmod, readlink, symlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

type Entry = { type: string; mode: number; data?: string; target?: string };
const root = "/task";
const safe = (name: string) => {
  const p = resolve(root, name);
  if (!p.startsWith(root + "/") || name.split("/").includes("..")) throw new Error("路径越界");
  return p;
};
const ignored = new Set(["node_modules", ".git", ".axi", ".claude"]);
if (process.argv[2] === "snapshot") {
  const entries: Record<string, Entry> = {}; let total = 0;
  async function visit(dir: string) {
    for (const name of (await readdir(join(root, dir))).sort()) {
      if (ignored.has(name)) continue;
      const relative = dir ? `${dir}/${name}` : name, path = safe(relative), st = await lstat(path);
      if (Object.keys(entries).length > 15000) throw new Error("源文件数量超限");
      const entry: Entry = { type: "special", mode: st.mode & 0o777 };
      if (st.isDirectory()) { entry.type = "directory"; entries[relative] = entry; await visit(relative); continue; }
      if (st.isSymbolicLink()) { entry.type = "symlink"; entry.target = await readlink(path); }
      if (st.isFile()) {
        total += st.size; if (total > 128 * 1024 * 1024) throw new Error("源码归档超限");
        entry.type = "file"; entry.data = (await readFile(path)).toString("base64");
      }
      entries[relative] = entry;
    }
  }
  await visit(""); console.log(JSON.stringify(entries));
} else if (["restore", "patch"].includes(process.argv[2] ?? "")) {
  const entries = JSON.parse(await Bun.stdin.text()) as Record<string, Entry>;
  // 先检查所有路径，再写入。父路径不可经由候选符号链接逃逸。
  for (const [name, e] of Object.entries(entries)) {
    const p = safe(name);
    if (!["file", "directory", "symlink"].includes(e.type)) throw new Error("拒绝特殊文件");
    if (e.type === "symlink" && (!e.target || !resolve(dirname(p), e.target).startsWith(root + "/"))) throw new Error("符号链接越界");
    let parent = dirname(p);
    while (parent !== root) {
      const st = await lstat(parent).catch(() => null);
      if (st?.isSymbolicLink()) throw new Error("父目录是符号链接");
      parent = dirname(parent);
    }
    const previous = await lstat(p).catch(() => null);
    if (previous?.isSymbolicLink()) throw new Error("拒绝覆盖符号链接");
  }
  for (const [name, e] of Object.entries(entries).sort(([a], [b]) => a.split("/").length - b.split("/").length)) {
    const p = safe(name);
    await mkdir(dirname(p), { recursive: true });
    if (e.type === "directory") await mkdir(p, { recursive: true });
    else if (e.type === "file") await writeFile(p, Buffer.from(e.data!, "base64"));
    else await symlink(e.target!, p);
    if (e.type !== "symlink") await chmod(p, e.mode & 0o777);
  }
}
