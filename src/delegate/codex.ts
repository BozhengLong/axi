import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isObject, type JsonObject, type RecordLog } from "../api/types.ts";
import { childEnvironment, events, terminate } from "./process.ts";

function disableConfiguredServers(): string[] {
  let config: unknown;
  try { config = Bun.TOML.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("无法核对 Codex 的本机配置。");
  }
  if (!isObject(config) || !isObject(config.mcp_servers)) return [];
  return Object.keys(config.mcp_servers).flatMap(name => {
    if (!/^[a-zA-Z0-9_@-]+$/.test(name)) throw new Error("Codex MCP 名称无法在预览模式安全禁用。");
    return ["-c", `mcp_servers.${name}.enabled=false`];
  });
}

export class LocalCodex {
  private child;
  private incoming;
  private diagnostics: Promise<void>;
  private nextId = 0;
  private thread?: string;
  private hiddenResponse?: number;
  private closed = false;

  constructor(cwd: string, private record: RecordLog) {
    this.child = Bun.spawn(["codex", "app-server", "--listen", "stdio://",
      "--disable", "hooks", "--disable", "plugins", "--disable", "apps", "--disable", "multi_agent",
      ...disableConfiguredServers(), "-c", "project_doc_max_bytes=0", "-c", 'shell_environment_policy.inherit="none"'], {
      cwd, env: childEnvironment(["CODEX_HOME"]), stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    this.incoming = events(this.child.stdout);
    this.diagnostics = this.drainStderr().catch(() => this.close());
  }

  private async drainStderr(): Promise<void> {
    for await (const chunk of this.child.stderr) this.record("delegate_stderr", { text: new TextDecoder().decode(chunk) });
  }

  private send(message: JsonObject): void {
    if (this.closed) throw new Error("Codex 进程已退出。请重开 Axi 会话。");
    this.record("delegate_send", message);
    this.child.stdin.write(JSON.stringify(message) + "\n");
    void this.child.stdin.flush();
  }

  private async receive(): Promise<JsonObject> {
    const message = await this.incoming.next();
    if (message.done) throw new Error("Codex 进程已退出。请检查本地 Trace 和 Codex 登录状态。");
    const event = message.value;
    if (typeof event.method === "string" && Object.hasOwn(event, "id")) {
      // 子进程的权限申请不授予临时目录以外的访问。
      this.record("delegate_request_denied", { method: event.method, id: event.id });
      this.send({ jsonrpc: "2.0", id: event.id, error: { code: -32601, message: "Permission escalation is disabled in the Axi preview." } });
      return {};
    }
    if (event.id !== this.hiddenResponse || this.hiddenResponse === undefined) this.record("delegate_receive", event);
    return event;
  }

  private async request(method: string, params: JsonObject, observe: (event: JsonObject) => void = () => {}): Promise<JsonObject> {
    const id = ++this.nextId;
    if (method === "config/read") this.hiddenResponse = id;
    this.send({ jsonrpc: "2.0", id, method, params });
    const timer = setTimeout(() => this.close(), 30_000);
    try {
      while (true) {
        const event = await this.receive();
        if (event.id !== id) { observe(event); continue; }
        if (isObject(event.error)) throw new Error(`Codex ${method} 失败：${String(event.error.message ?? event.error.code)}`);
        if (!isObject(event.result)) throw new Error(`Codex ${method} 响应缺少结果。`);
        return event.result;
      }
    } finally {
      clearTimeout(timer);
      if (this.hiddenResponse === id) this.hiddenResponse = undefined;
    }
  }

  async turn(cwd: string, prompt: string, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    signal.throwIfAborted();
    let active: string | undefined, finish: JsonObject | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    let sentInterrupt = false;
    const interrupt = () => {
      if (!grace) grace = setTimeout(() => this.close(), 6000);
      if (!active || sentInterrupt || this.closed) return;
      sentInterrupt = true;
      try { this.send({ jsonrpc: "2.0", id: ++this.nextId, method: "turn/interrupt", params: { threadId: this.thread, turnId: active } }); }
      catch { this.close(); }
    };
    const matches = (event: JsonObject) => isObject(event.params) && event.params.threadId === this.thread;
    const observe = (event: JsonObject) => {
      if (!matches(event) || !isObject(event.params)) return;
      const params = event.params;
      if (event.method === "turn/started" && isObject(params.turn) && typeof params.turn.id === "string") {
        active ??= params.turn.id;
        if (signal.aborted) interrupt();
      }
      if (event.method === "item/agentMessage/delta" && typeof params.delta === "string" && !signal.aborted) output(params.delta);
      if (event.method === "turn/completed" && isObject(params.turn) && params.turn.id === active) finish = params.turn;
    };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      if (!this.thread) {
        await this.request("initialize", { clientInfo: { name: "axi_local_preview", version: "0.0.2" } });
        this.send({ jsonrpc: "2.0", method: "initialized" });
        signal.throwIfAborted();
        const effective = await this.request("config/read", { cwd, includeLayers: false });
        const servers = isObject(effective.config) ? effective.config.mcp_servers : undefined;
        if (!isObject(effective.config) || (isObject(servers) && Object.values(servers).some(server => !isObject(server) || server.enabled !== false))) {
          throw new Error("预览模式无法禁用全部 Codex MCP 扩展。");
        }
        this.record("delegate_codex_policy", { mcp: "disabled", approval: "never", network: false });
        signal.throwIfAborted();
        const opened = await this.request("thread/start", { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "workspace-write",
          developerInstructions: "Edit only the specific file within the temporary Git workspace. Do not use absolute paths to any other project. Read the current file every turn." });
        if (!isObject(opened.thread) || typeof opened.thread.id !== "string") throw new Error("Codex 响应缺少会话 ID。");
        this.thread = opened.thread.id;
      }
      signal.throwIfAborted();
      const started = await this.request("turn/start", {
        threadId: this.thread, cwd, input: [{ type: "text", text: prompt }], effort: "low",
        approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd],
          networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
      }, observe);
      if (!isObject(started.turn) || typeof started.turn.id !== "string") throw new Error("Codex 响应缺少任务 ID。");
      if (active && active !== started.turn.id) throw new Error("Codex 任务 ID 不一致。");
      active = started.turn.id;
      if (signal.aborted) interrupt();
      while (!finish) observe(await this.receive());
      signal.throwIfAborted();
      if (finish.status !== "completed") {
        const detail = isObject(finish.error) ? String(finish.error.message ?? "") : "";
        throw new Error(`Codex 本轮未完成（${String(finish.status)}）${detail ? "：" + detail : ""}。`);
      }
    } catch (error) {
      if (!finish) this.close();
      throw error;
    } finally {
      signal.removeEventListener("abort", interrupt);
      if (grace) clearTimeout(grace);
    }
  }

  get isClosed(): boolean { return this.closed; }

  async shutdown(): Promise<void> {
    this.close();
    await this.child.exited;
    await this.diagnostics;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch {}
    terminate(this.child.pid, "SIGTERM");
    const hardStop = setTimeout(() => terminate(this.child.pid, "SIGKILL"), 1200);
    void this.child.exited.then(() => clearTimeout(hardStop));
  }
}
