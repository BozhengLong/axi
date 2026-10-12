import { abortError } from "../api/types.ts";

export type ReadLine = (prompt: string, signal?: AbortSignal) => Promise<string | null>;
export interface Permission { allowed: boolean; reason?: string }

export async function confirmCommand(command: string, cwd: string, read: ReadLine, write: (text: string) => void, signal: AbortSignal): Promise<Permission> {
  signal.throwIfAborted();
  write(`\n工作目录：${cwd}\n完整命令：\n${command}\n`);
  while (true) {
    const answer = await read("执行这次调用？[y/N] ", signal);
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
