import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import type { ToolUse } from "../../../src/api/types.ts";
import { visibleText } from "../../../src/text.ts";
import { permissionDisplay } from "../../../src/ui/permission.ts";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const stable = (value: any): string => value && typeof value === "object" ? Array.isArray(value) ? `[${value.map(stable)}]` : `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",")}}` : JSON.stringify(value);
const textLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// 与产品的差异生成算法独立：解析已经展示的单块补丁，实际应用后核对完整目标。
export function applyPreview(before: string, preview: string): string {
  const rows = preview.split("\n");
  if (!rows[0]?.startsWith("--- ") || !rows[1]?.startsWith("+++ ")) throw new Error("缺少差异文件头");
  const match = rows[2]?.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
  if (!match || match[1] !== match[3]) throw new Error("差异区间无效");
  const oldRows: string[] = [], newRows: string[] = []; let prior = "";
  for (const row of rows.slice(3, -1)) {
    if (row === "\\ No newline at end of file") {
      if (![" ", "+", "-"].includes(prior)) throw new Error("无效末行标记");
      if (prior !== "+") oldRows[oldRows.length - 1] = oldRows.at(-1)!.slice(0, -1);
      if (prior !== "-") newRows[newRows.length - 1] = newRows.at(-1)!.slice(0, -1);
      prior = ""; continue;
    }
    const mark = row[0]; if (![" ", "+", "-"].includes(mark!)) throw new Error("差异行前缀无效");
    const line = row.slice(1) + "\n";
    if (mark !== "+") oldRows.push(line);
    if (mark !== "-") newRows.push(line);
    prior = mark!;
  }
  if (oldRows.length !== Number(match[2]) || newRows.length !== Number(match[4])) throw new Error("差异行数不符");
  const original = textLines(before), start = Number(match[1]) - 1;
  if (start > original.length || original.slice(start, start + oldRows.length).join("") !== oldRows.join("")) throw new Error("差异旧内容与现场不符");
  return original.slice(0, start).join("") + newRows.join("") + original.slice(start + oldRows.length).join("");
}

export function verifyPermission(tool: ToolUse, observed: any): { expected: string; view: any } {
  const request = observed.request;
  if (!request || request.toolUseId !== tool.id || request.name !== tool.name || stable(request.input) !== stable(tool.input)) throw new Error("原生授权请求与完整 API 工具调用不符");
  if (tool.name === "bash") {
    if (request.effect !== "shell" || typeof tool.input.command !== "string") throw new Error("bash 效果类型不符");
    return { expected: visibleText(`工作目录：/task\n完整命令：\n${tool.input.command}\n执行这次调用？[y/N] `), view: request };
  }
  const name = tool.name, path = tool.input.path ?? ".";
  if (typeof path !== "string") throw new Error("工具路径无效");
  const absolute = resolve("/task", path), rel = relative("/task", absolute) || ".";
  if (rel === ".." || rel.startsWith("../") || request.path !== rel) throw new Error("工具路径与提案不符");
  if (["write", "edit"].includes(name)) {
    const p = observed.proposal;
    if (request.effect !== "write" || !p || p.toolUseId !== tool.id || p.path !== rel || p.proposalId !== request.proposalId || p.preview !== request.preview || p.previewHash !== request.previewHash || p.previewHash !== sha(p.preview)) throw new Error("修改提案缺失或预览摘要不符");
    const bytes = observed.file ? Buffer.from(observed.file.data, "base64") : null;
    const before = bytes ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : "";
    let expected: string;
    if (name === "write") {
      if (bytes !== null || p.beforeHash !== null || typeof tool.input.content !== "string") throw new Error("新建操作的现场不符");
      expected = tool.input.content;
    } else {
      const { old_text: old, new_text: next, base_version: version } = tool.input;
      if (!bytes || p.beforeHash !== sha(bytes) || typeof old !== "string" || !old.length || typeof next !== "string" || typeof version !== "string" || !version.length) throw new Error("编辑参数或旧文件摘要不符");
      const at = before.indexOf(old);
      if (at < 0 || before.indexOf(old, at + 1) >= 0) throw new Error("编辑不是唯一匹配");
      expected = before.slice(0, at) + next + before.slice(at + old.length);
    }
    const headers = p.preview.split("\n");
    if (headers[0] !== `--- ${name === "write" ? "/dev/null（新文件）" : JSON.stringify(rel) + "（当前）"}` || headers[1] !== `+++ ${JSON.stringify(rel)}（拟写入）`) throw new Error("差异文件头与目标不符");
    if (p.afterHash !== sha(Buffer.from(expected)) || applyPreview(before, p.preview) !== expected) throw new Error("展示差异未覆盖实际工具修改");
    if (Array.from(visibleText(p.preview)).length > 30000) throw new Error("预览超过固定上限");
  } else if (!["read", "glob", "grep"].includes(name) || request.effect !== "read") throw new Error("不支持的授权类型");
  const prompt = request.effect === "write" ? "应用这次修改？[y/N] " : "执行这次读取？[y/N] ";
  return { expected: visibleText(permissionDisplay(tool, "/task", request) + prompt).trimStart(), view: request };
}
