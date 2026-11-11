import { mkdirSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { loadConfig } from "../../src/config.ts";

export const ROOT = resolve(import.meta.dir, "../..");
export const STORE = join(homedir(), ".local/share/axi-evals");
export const IMAGE = process.env.AXI_EVAL_IMAGE ?? "axi-eval:20261110";
export type SeedFiles = Record<string, string | Uint8Array>;
export const LABEL = "axi.eval.batch";
export type Snapshot = Record<string, { type: string; mode: number; data?: string; target?: string }>;
export type Batch = { id: string; directory: string; relay: string; admin: string; endpoint: string; image: string; created: string };
export type Runtime = { id: string; token: string; name: string; network: string; ip: string; directory: string; taskVolume?: string };

export function save(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
}
export async function command(args: string[], input?: string, allowFailure = false, timeoutMs = 30000) {
  const proc = Bun.spawn(args, { cwd: ROOT, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined) { proc.stdin!.write(input); proc.stdin!.end(); }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  let total = 0;
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) { total += chunk.byteLength; if (total > 200 * 1024 * 1024) { proc.kill("SIGKILL"); throw new Error("命令输出超过证据上限"); } chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
  clearTimeout(timer);
  if (exitCode && !allowFailure) throw new Error(`${args.slice(0, 3).join(" ")} failed (${exitCode}): ${stderr.slice(0, 2000)}`);
  return { stdout, stderr, exitCode };
}
export const docker = (args: string[], input?: string, allowFailure = false, timeoutMs?: number) => command(["docker", ...args], input, allowFailure, timeoutMs);

export async function control(batch: Batch, action: string, data: unknown) {
  // Bun 1.3.14 实测仍把空 proxy 请求发给外部代理。控制通道用明确的 curl 绕过规则。
  // 模型流仍由 Bun fetch 原样转发，未更换被测客户端的网络实现。
  const result = await command(["curl", "--noproxy", "*", "--max-time", "15", "-fsS", `${batch.endpoint}/control/${action}`, "-H", `Authorization: Bearer ${batch.admin}`, "-H", "content-type: application/json", "--data-binary", "@-"], JSON.stringify(data));
  return JSON.parse(result.stdout) as any;
}
export function current(): Batch { return JSON.parse(readFileSync(join(STORE, "current.json"), "utf8")); }

export async function initialize(): Promise<Batch> {
  const id = `b${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const directory = join(STORE, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, "relay"), { mode: 0o700 });
  const config = loadConfig();
  const admin = crypto.randomUUID();
  const relay = `axi-eval-${id}-relay`;
  const envFile = join(directory, "relay.env");
  writeFileSync(envFile, `EVAL_ADMIN_TOKEN=${admin}\nEVAL_UPSTREAM_URL=${config.url}\nEVAL_UPSTREAM_KEY=${config.apiKey}\n`, { mode: 0o600 });
  // 转发服务没有宿主机工作目录，只挂载本批证据目录。
  await docker(["run", "-d", "--name", relay, "--label", `${LABEL}=${id}`, "--user", "1000:1000", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--pids-limit", "64", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--env-file", envFile, "--mount", `type=bind,src=${join(directory, "relay")},dst=/evidence`, "-p", "127.0.0.1::8787", IMAGE, "bun", "/opt/eval/relay.ts"]);
  unlinkSync(envFile);
  const port = (await docker(["port", relay, "8787/tcp"])).stdout.trim();
  const image = (await docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"])).stdout.trim();
  const batch = { id, directory, relay, admin, endpoint: `http://${port}`, image, created: new Date().toISOString() };
  save(join(STORE, "current.json"), batch); save(join(directory, "private-state.json"), batch);
  await Bun.sleep(500);
  return batch;
}
export async function restartRelay(batch: Batch) {
  const active = (await docker(["ps", "-a", "--filter", `${"label"}=${LABEL}=${batch.id}`, "--format", "{{.Names}}"])).stdout.trim().split("\n").filter(Boolean);
  if (active.some(name => name !== batch.relay)) throw new Error("仍有测试容器，不能替换转发服务");
  const config = loadConfig(), path = join(batch.directory, "relay.env"), oldImage = batch.image;
  writeFileSync(path, `EVAL_ADMIN_TOKEN=${batch.admin}\nEVAL_UPSTREAM_URL=${config.url}\nEVAL_UPSTREAM_KEY=${config.apiKey}\n`, { mode: 0o600 });
  await docker(["rm", "-f", batch.relay], undefined, true);
  try {
    await docker(["run", "-d", "--name", batch.relay, "--label", `${LABEL}=${batch.id}`, "--user", "1000:1000", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--pids-limit", "64", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--env-file", path, "--mount", `type=bind,src=${join(batch.directory, "relay")},dst=/evidence`, "-p", "127.0.0.1::8787", IMAGE, "bun", "/opt/eval/relay.ts"]);
  } finally { unlinkSync(path); }
  batch.endpoint = `http://${(await docker(["port", batch.relay, "8787/tcp"])).stdout.trim()}`;
  batch.image = (await docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"])).stdout.trim();
  save(join(STORE, "current.json"), batch); save(join(batch.directory, "private-state.json"), batch);
  save(join(batch.directory, `relay-revision-${Date.now()}.json`), { oldImage, image: batch.image, time: new Date().toISOString() });
}
export async function createRuntime(batch: Batch, id: string, options: { mock?: any[]; policy?: string; files?: SeedFiles; taskVolume?: string; mounts?: string[]; maxRounds?: number; maxTotal?: number } = {}): Promise<Runtime> {
  const token = crypto.randomUUID(), name = `axi-eval-${batch.id}-${id}`, network = `${name}-net`;
  const directory = join(batch.directory, id); mkdirSync(directory, { mode: 0o700 });
  try {
  await docker(["network", "create", "--internal", "--label", `${LABEL}=${batch.id}`, network]);
  await docker(["network", "connect", network, batch.relay]);
  const addresses = JSON.parse((await docker(["inspect", batch.relay, "--format", "{{json .NetworkSettings.Networks}}"])).stdout);
  const ip = addresses[network].IPAddress;
  await control(batch, "register", { id, token, mock: options.mock, policy: options.policy, maxRounds: options.maxRounds, maxTotal: options.maxTotal });
  const env: Record<string, string> = {
    AXI_EVAL_RELAY_IP: ip, ANTHROPIC_BASE_URL: `http://${ip}:8787`, ANTHROPIC_API_KEY: token,
    CLAUDE_CONFIG_DIR: "/home/eval/.claude", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  await docker(["run", "-d", "--name", name, "--label", `${LABEL}=${batch.id}`, "--network", network, "--user", "0", "--read-only", "--cap-drop=ALL", "--cap-add=NET_ADMIN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--cap-add=CHOWN", "--security-opt", "no-new-privileges", "--cpus", "2", "--memory", "4g", "--pids-limit", "256", ...(options.taskVolume ? ["--mount", `type=volume,src=${options.taskVolume},dst=/task`] : ["--tmpfs", "/task:rw,nosuid,size=200m,mode=755"]), ...(options.mounts ?? []).flatMap(m => ["--mount", m]), "--tmpfs", "/home/eval:rw,nosuid,size=256m,mode=755", "--tmpfs", "/tmp:rw,nosuid,size=256m,mode=1777", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), batch.image]);
  const runtime = { id, token, name, network, ip, directory, ...(options.taskVolume ? { taskVolume: options.taskVolume } : {}) };
  await Bun.sleep(100);
  await execute(runtime, ["bun", "/opt/eval/files.ts", "seed"], encodeFiles(options.files ?? {}));
  return runtime;
  } catch (error) {
    await control(batch, "revoke", { id }).catch(() => {});
    await docker(["rm", "-f", name], undefined, true);
    await docker(["network", "disconnect", network, batch.relay], undefined, true);
    await docker(["network", "rm", network], undefined, true);
    throw error;
  }
}

// 每个 docker exec 也经过能力清理，避免继承初始化网络时使用的权限。
export const launchPrefix = ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"];
export function execArgs(runtime: Pick<Runtime, "name">, args: string[], tty = false) { return ["docker", "exec", ...(tty ? ["-it"] : ["-i"]), "--user", "0", runtime.name, ...launchPrefix, ...args]; }
export const execute = (runtime: Pick<Runtime, "name">, args: string[], input?: string, allowFailure = false, timeoutMs?: number) => command(execArgs(runtime, args), input, allowFailure, timeoutMs);
export const snapshot = async (runtime: Pick<Runtime, "name">): Promise<Snapshot> => JSON.parse((await execute(runtime, ["bun", "/opt/eval/files.ts", "snapshot"])).stdout);
export async function freeze(runtime: Pick<Runtime, "name">) {
  // 验收前结束被测进程及后台残留；保留 PID 1 和当前收尾进程以读取 tmpfs 产物。
  await execute(runtime, ["bun", "-e", 'import{readdirSync,readFileSync}from"node:fs";for(const p of readdirSync("/proc")){const id=Number(p);if(!id||id===1||id===process.pid)continue;try{const s=readFileSync(`/proc/${id}/status`,"utf8");if(/^Uid:\\s+1000\\s/m.test(s))process.kill(id,"SIGKILL")}catch{}}']);
}
export const encodeFiles = (files: SeedFiles) => JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { data: Buffer.from(typeof content === "string" ? new TextEncoder().encode(content) : content).toString("base64"), mode: 0o644 }])));
export async function destroyRuntime(batch: Batch, runtime: Runtime) {
  await control(batch, "revoke", { id: runtime.id }).catch(() => {});
  // 清理环境前保留原生日志；即使任务失败，也要留下缺失原因。
  try {
    await freeze(runtime);
    const { collectNativeTrace, finalizeTrace } = await import("./trace.ts");
    await collectNativeTrace(runtime); finalizeTrace(batch, runtime);
  } catch (error) { save(join(runtime.directory, "trace-collection-error.json"), { error: String(error) }); }
  await docker(["rm", "-f", runtime.name], undefined, true);
  await docker(["network", "disconnect", runtime.network, batch.relay], undefined, true);
  await docker(["network", "rm", runtime.network], undefined, true);
}

if (import.meta.main) {
  if (process.argv[2] === "init") {
    const b = await initialize(); console.log(JSON.stringify({ id: b.id, directory: b.directory, image: b.image }));
  } else if (process.argv[2] === "restart-relay") {
    const b = current(); await restartRelay(b); console.log(JSON.stringify({ id: b.id, image: b.image }));
  } else if (process.argv[2] === "cleanup") {
    const b = current();
    const containers = (await docker(["ps", "-aq", "--filter", `label=${LABEL}=${b.id}`])).stdout.trim().split(/\s+/).filter(Boolean);
    if (containers.length) await docker(["rm", "-f", ...containers]);
    const networks = (await docker(["network", "ls", "-q", "--filter", `label=${LABEL}=${b.id}`])).stdout.trim().split(/\s+/).filter(Boolean);
    if (networks.length) await docker(["network", "rm", ...networks]);
    console.log(JSON.stringify({ cleaned: b.id, containers: containers.length, networks: networks.length }));
  }
}
