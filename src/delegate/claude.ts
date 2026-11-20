import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isObject, type RecordLog } from "../api/types.ts";
import { childEnvironment, events, terminate } from "./process.ts";

export async function claudeTurn(cwd: string, scratch: string, project: string, prompt: string, signal: AbortSignal,
  record: RecordLog, output: (text: string) => void): Promise<void> {
  signal.throwIfAborted();
  if (process.platform !== "darwin") throw new Error("Claude Code 预览入口目前需要 macOS。");
  const home = join(scratch, "claude-home");
  mkdirSync(home, { mode: 0o700 });
  const env = childEnvironment(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  if (!env.ANTHROPIC_BASE_URL || !(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) throw new Error("请在本机配置现有 Claude Code API 网关。");
  const policy = `(version 1) (allow default) (deny file-write*)
(allow file-write* (subpath ${JSON.stringify(scratch)})) (allow file-write-data (literal "/dev/null")) (deny file-read* file-write* (subpath ${JSON.stringify(project)}))`;
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", policy, "claude", "--bare", "-p", "--output-format", "stream-json",
    "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk", "--tools", "Read,Edit",
    "--allowedTools", "Read,Edit", "--setting-sources", "", "--disable-slash-commands", "--model", "claude-opus-5-5"], {
    cwd, env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), TMPDIR: home },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
  });
  let success = false;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    terminate(child.pid, "SIGTERM");
    hardStop = setTimeout(() => terminate(child.pid, "SIGKILL"), 1500);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    record("delegate_claude_prompt", { prompt });
    child.stdin.write(prompt + "\n");
    child.stdin.end();
    const diagnostics = (async () => {
      for await (const chunk of child.stderr) record("delegate_stderr", { text: new TextDecoder().decode(chunk) });
    })();
    const messages = (async () => {
      for await (const event of events(child.stdout)) {
        record("delegate_receive", event);
        if (event.type === "assistant" && isObject(event.message) && Array.isArray(event.message.content)) {
          for (const item of event.message.content) if (isObject(item) && item.type === "text" && typeof item.text === "string") output(item.text);
        }
        if (event.type === "result") success = event.subtype === "success" && !event.is_error;
      }
    })();
    const [code] = await Promise.all([child.exited, diagnostics, messages]);
    signal.throwIfAborted();
    if (code !== 0 || !success) throw new Error("Claude Code 本轮未完成。请检查本机 Trace 和网关状态。");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (hardStop) clearTimeout(hardStop);
    if (child.exitCode === null) terminate(child.pid, "SIGKILL");
    await child.exited;
  }
}
