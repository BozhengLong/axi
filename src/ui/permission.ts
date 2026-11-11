import { abortError } from "../api/types.ts";
import type { ToolUse } from "../api/types.ts";
import type { PermissionView } from "../tools/registry.ts";

export type PermissionMode = "project" | "strict";

export type ReadLine = (prompt: string, signal?: AbortSignal) => Promise<string | null>;
export interface Permission { allowed: boolean; reason?: string }

export async function confirmCommand(command: string, cwd: string, read: ReadLine, write: (text: string) => void, signal: AbortSignal): Promise<Permission> {
  signal.throwIfAborted();
  write(`\n工作目录：${cwd}\n完整命令：\n${command}\n`);
  return confirmAnswer("执行这次调用？[y/N] ", read, write, signal);
}

export function permissionDisplay(tool: ToolUse, cwd: string, view: PermissionView): string {
  const path = JSON.stringify(view.path ?? tool.input.path ?? ".");
  return `\n项目目录：${JSON.stringify(cwd)}\n${view.effect === "write" ? "修改文件" : "读取/搜索"}：${path}\n工具：${tool.name}\n${view.preview ? view.preview + "\n" : `参数：${JSON.stringify(tool.input)}\n`}`;
}

export async function confirmTool(tool: ToolUse, cwd: string, view: PermissionView, read: ReadLine, write: (text: string) => void, signal: AbortSignal): Promise<Permission> {
  if (view.effect === "shell") return confirmCommand(tool.input.command as string, cwd, read, write, signal);
  signal.throwIfAborted(); write(permissionDisplay(tool, cwd, view));
  return confirmAnswer(view.effect === "write" ? "应用这次修改？[y/N] " : "执行这次读取？[y/N] ", read, write, signal);
}

async function confirmAnswer(prompt: string, read: ReadLine, write: (text: string) => void, signal: AbortSignal): Promise<Permission> {
  while (true) {
    signal.throwIfAborted();
    const answer = await read(prompt, signal);
    if (answer === null) throw abortError();
    // 只接受单独的小写 y。粘贴多行、yes 或其他输入不会变成授权。
    if (answer.trim() === "y") return { allowed: true };
    if (answer.trim() === "" || answer.trim() === "n") {
      const reason = await read("拒绝理由（选填，回车跳过）：", signal);
      if (reason === null) throw abortError();
      return { allowed: false, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    }
    write("请输入 y 执行，或输入 n / 直接回车拒绝。\n");
  }
}
