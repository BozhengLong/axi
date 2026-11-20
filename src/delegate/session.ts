import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage, type RecordLog } from "../api/types.ts";
import { redact } from "../api/wire.ts";
import { SessionLog } from "../log.ts";
import { FileWorkspace } from "../tools/files.ts";
import { confirmTool } from "../ui/permission.ts";
import { Terminal } from "../ui/terminal.ts";
import { claudeTurn } from "./claude.ts";
import { LocalCodex } from "./codex.ts";
import { childEnvironment } from "./process.ts";

export type LocalAgentName = "codex" | "claude";

export async function runLocalSession(name: LocalAgentName, file: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("本机代理预览需要交互终端。");
  const cwd = realpathSync(process.cwd());
  const workspace = new FileWorkspace(cwd);
  const path = workspace.paths.check(file).relative;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axi-local-")));
  const secrets = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "BAILIAN_CODING_PLAN_API_KEY"]
    .map(key => process.env[key]?.trim()).filter((key): key is string => Boolean(key));
  const scrub = (text: string) => secrets.reduce((value, key) => redact(value, key), text);
  let log: SessionLog | undefined, ui: Terminal | undefined, codex: LocalCodex | undefined;
  let active: AbortController | undefined;
  const cancel = () => active?.abort();
  try {
    log = new SessionLog(cwd);
    const sessionLog = log;
    const record: RecordLog = (kind, data) => sessionLog.record(kind,
      JSON.parse(JSON.stringify(data, (key, value) =>
        /^(accessToken|refreshToken|apiKey|authorization)$/i.test(key) ? "[已隐藏]" : typeof value === "string" ? scrub(value) : value)));
    const terminal = ui = new Terminal(true);
    terminal.filterOutput = scrub;
    terminal.onInterrupt = cancel;
    terminal.onClose = cancel;
    process.on("SIGINT", cancel);
    record("delegate_session", { name, path });
    terminal.write(`Axi 本机代理预览（${name}）\n目标：${path}\n每轮复制目标文件，原项目中的修改需批准。Ctrl+C 中止，/exit 退出。\nTrace：${sessionLog.path}\n`);
    while (!terminal.closed) {
      active = new AbortController();
      const signal = active.signal;
      let scratch: string | undefined;
      let stage = "input";
      try {
        const input = await terminal.read("\n本机代理 > ", signal);
        if (input === null || input.trim() === "/exit") break;
        if (!input.trim()) continue;
        stage = "snapshot";
        const original = await workspace.snapshot(path, signal);
        const version = workspace.remember(original);
        scratch = mkdtempSync(join(root, "turn-"));
        const folder = join(scratch, "project");
        const target = join(folder, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, original.bytes, { flag: "wx", mode: 0o600 });
        const env = { ...childEnvironment([]), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
        if (Bun.spawnSync(["git", "init", "-q", "--template="], { cwd: folder, env, stderr: "pipe" }).exitCode !== 0) throw new Error("无法创建临时 Git 目录。");
        const prompt = `In this turn's temporary Git workspace, read and edit only ${JSON.stringify(path)}. Read the current copy before editing. Do not create other files or touch any other workspace. The host will review the actual diff before changing the user's project.\n\nUser task:\n${input}`;
        record("delegate_turn", { name, path, hash: original.hash, input });
        stage = "run";
        terminal.write("本机代理正在处理临时副本…\n");
        const output = (text: string) => { if (!signal.aborted) terminal.stream("text", text); };
        if (name === "codex") {
          if (!codex || codex.isClosed) {
            await codex?.shutdown();
            codex = new LocalCodex(root, record);
          }
          await codex.turn(folder, prompt, signal, output);
        } else await claudeTurn(folder, scratch, cwd, prompt, signal, record, output);
        terminal.endStream();
        signal.throwIfAborted();
        stage = "proposal";
        const copy = await new FileWorkspace(folder).snapshot(path, signal);
        if (copy.hash === original.hash) {
          record("delegate_no_change", { path });
          terminal.write("本轮没有可写回的修改。\n");
          continue;
        }
        const proposal = await workspace.prepareReplacement(path, version, copy.text, signal);
        record("proposal", { ...proposal });
        stage = "approval";
        const answer = await confirmTool({ type: "tool_use", id: proposal.id, name: "edit", input: { path } }, cwd,
          { effect: "write", path, preview: proposal.preview }, terminal.read, terminal.write, signal);
        record("permission", { proposalId: proposal.id, path, ...answer });
        if (!answer.allowed) {
          terminal.write("已拒绝写回。\n");
          continue;
        }
        stage = "commit";
        const result = await workspace.commit(proposal, signal, record);
        if (result.isError || result.fatal) {
          terminal.write(`写回结果：${result.content}\n`);
          break;
        }
        terminal.write(`已应用修改：${path}\n`);
      } catch (error) {
        terminal.endStream();
        record("delegate_error", { stage, cancelled: signal.aborted, message: errorMessage(error) });
        terminal.write(signal.aborted ? "本轮已中止。\n" : `错误：${errorMessage(error)}\n`);
      } finally {
        active = undefined;
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    await codex?.shutdown();
    ui?.close();
    log?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
