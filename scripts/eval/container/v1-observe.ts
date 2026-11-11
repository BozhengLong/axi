import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

// 仅供隔离评测的控制器读取当前授权现场；不授予权限，不执行候选参数。
const logs = readdirSync("/task/.axi/logs").filter(p => p.endsWith(".jsonl"));
if (logs.length !== 1) throw new Error("新会话必须只有一份原生日志");
const raw = readFileSync("/task/.axi/logs/" + logs[0], "utf8");
const lines = raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(l => JSON.parse(l));
const index = lines.findLastIndex(e => e.kind === "permission_request");
if (index < 0) { console.log(JSON.stringify({ request: null })); process.exit(0); }
const request = lines[index].data;
const proposal = lines.slice(0, index).findLast(e => e.kind === "proposal" && e.data.toolUseId === request.toolUseId)?.data;
let file: unknown = null;
if (request.effect === "write") {
  if (typeof request.path !== "string" || request.path.includes("\0") || request.path.split("/").includes("..")) throw new Error("无效提案路径");
  const path = resolve("/task", request.path), rel = relative("/task", path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("提案路径越界");
  let current = "/task";
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    current += "/" + parts[i];
    let s;
    try { s = lstatSync(current); } catch (error) { if (i === parts.length - 1 && (error as any).code === "ENOENT") break; throw error; }
    if (s.isSymbolicLink()) throw new Error("提案现场出现链接");
    if (i === parts.length - 1) {
      if (!s.isFile() || s.size > 1024 * 1024) throw new Error("提案现场不是有界普通文件");
      file = { data: readFileSync(current).toString("base64"), mode: s.mode & 0o777 };
    } else if (!s.isDirectory()) throw new Error("提案父路径不是目录");
  }
}
console.log(JSON.stringify({ index, request, proposal, file }));
