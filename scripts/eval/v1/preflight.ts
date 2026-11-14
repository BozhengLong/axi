import { STUDY } from "./settings.ts";
import { join, dirname } from "node:path";
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT, STORE, initialize, createRuntime, destroyRuntime, execute, save, docker, type Runtime } from "../core.ts";
import { runAxi, runClaude } from "../adapters.ts";
import { runAxiV1 } from "./adapter.ts";
import { runtimeFingerprint } from "./fingerprint.ts";
import { fingerprint } from "../complex/fingerprint.ts";

const study = STUDY, image = process.env.AXI_EVAL_IMAGE;
if (process.argv[2] !== "--live" || !image?.startsWith("sha256:")) throw new Error("完整前置必须显式 --live 和固定 image ID");
const smoke = JSON.parse(readFileSync(join(study, "smoke-latest.json"), "utf8"));
if (!smoke.complete || smoke.image !== image || smoke.checks.length !== 9 || smoke.checks.some((x: any) => !x.passed)) throw new Error("当前镜像模拟检查未完成");
const frozen = fingerprint(), runtime = runtimeFingerprint(), checks: any[] = [];
for (const [path, hash] of Object.entries(runtime.runtimeHashes)) {
  if (path === "scripts/eval/v1/fingerprint.ts") continue;
  if (smoke.hashes[path] !== hash) throw new Error("模拟检查后运行组件发生变化：" + path);
}
const batch = await initialize();
for (const path of Object.keys(frozen.hashes)) { const dest = join(batch.directory, "source-snapshot", path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, readFileSync(join(ROOT, path)), { mode: 0o600 }); }
save(join(batch.directory, "manifest.json"), { batch: batch.id, suite: "v1-preflight", image, traceVersion: 2, ...frozen, ...runtime });
function check(name: string, pass: boolean, evidence?: unknown) {
  checks.push({ name, pass, evidence }); save(join(batch.directory, "preflight.json"), { complete: false, image, checks });
  console.log(JSON.stringify({ name, pass })); if (!pass) throw new Error("前置检查失败：" + name);
}
async function inspect(id: string, action: (r: Runtime) => Promise<void>, mock: unknown[] | null = []) {
  const r = await createRuntime(batch, id, { mock: mock ?? undefined, maxRounds: 1, maxTotal: 12 });
  try { await action(r); } finally { await destroyRuntime(batch, r); }
  if (id.startsWith("live-")) {
    const trace = JSON.parse(readFileSync(join(r.directory, "trace-manifest.json"), "utf8")); check(id + " Trace", trace.status === "complete_observable", trace.missing);
  }
}
function sourceHashes(root: string) {
  const out: Record<string, string> = {};
  function walk(path: string) { for (const e of readdirSync(join(root, path), { withFileTypes: true })) { const name = path + "/" + e.name; if (e.isDirectory()) walk(name); else out[name] = createHash("sha256").update(readFileSync(join(root, name))).digest("hex"); } }
  walk("src"); return out;
}
let complete = false;
try {
  await inspect("isolation", async r => {
    const identity = await execute(r, ["sh", "-c", 'id -u; grep -E "Cap(Eff|Prm|Bnd)|NoNewPrivs" /proc/self/status']);
    check("非root且无额外能力", identity.stdout.includes("1000\n") && !identity.stdout.match(/Cap(?:Eff|Prm|Bnd):\s+0*[1-9a-f]/) && identity.stdout.includes("NoNewPrivs:\t1"), identity.stdout);
    const host = JSON.parse((await docker(["inspect", r.name, "--format", "{{json .HostConfig}}"])).stdout);
    check("固定CPU内存和只读根", host.NanoCpus === 2000000000 && host.Memory === 4 * 1024 ** 3 && host.ReadonlyRootfs && host.PidsLimit === 256);
    const versions = await execute(r, ["sh", "-c", "bun --version; claude --version; node --version; pnpm --version"]);
    const nodeVersion = process.env.AXI_V1_NODE_PROFILE === "node22" ? "v22.23.5" : "v24.22.2";
    check("固定工具版本", versions.stdout.includes("1.3.14") && versions.stdout.includes("2.1.322") && versions.stdout.includes(nodeVersion) && versions.stdout.includes("10.34.9"), versions.stdout);
    const prohibited: [string, string[]][] = [
      ["公网IP", ["curl", "-sS", "--max-time", "2", "http://1.1.1.1"]], ["公网域名", ["curl", "-sS", "--max-time", "2", "https://example.com"]],
      ["宿主访问", ["curl", "-sS", "--max-time", "2", "http://host.docker.internal:80"]], ["非代理端口", ["curl", "-sS", "--max-time", "2", `http://${r.ip}:80`]],
      ["修改网络", ["iptables", "-P", "OUTPUT", "ACCEPT"]], ["写产品源码", ["touch", "/opt/axi/forbidden"]],
      ["DockerSocket", ["test", "-S", "/var/run/docker.sock"]], ["宿主源码", ["test", "-e", ROOT + "/.env"]],
      ["测试镜像材料", ["test", "-e", "/opt/checks"]],
    ];
    for (const [name, args] of prohibited) check("阻止" + name, (await execute(r, args, undefined, true)).exitCode !== 0);
    const privateEnv = await execute(r, ["bun", "-e", 'console.log(["EVAL_UPSTREAM_KEY","EVAL_UPSTREAM_URL","EVAL_ADMIN_TOKEN"].some(k=>!!process.env[k]))']);
    check("候选没有真实凭据", privateEnv.stdout.trim() === "false");
    const admin = await execute(r, ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://${r.ip}:8787/control/state`]); check("管理接口拒绝候选", admin.stdout === "403");
    for (const [name, local, remote] of [["新Axi", ROOT, "/opt/axi"], ["旧Axi", join(study, "baseline"), "/opt/axi-v0"]]) {
      const script = 'import{readdirSync,readFileSync}from"node:fs";import{createHash}from"node:crypto";const root=process.argv[1],o={};function walk(p){for(const e of readdirSync(root+"/"+p,{withFileTypes:true})){const n=p+"/"+e.name;if(e.isDirectory())walk(n);else o[n]=createHash("sha256").update(readFileSync(root+"/"+n)).digest("hex");}}walk("src");console.log(JSON.stringify(o));';
      const remoteHashes = JSON.parse((await execute(r, ["bun", "-e", script, remote!])).stdout), localHashes = sourceHashes(local!);
      check(name + "镜像源码逐文件一致", Object.keys(remoteHashes).length === Object.keys(localHashes).length && Object.entries(localHashes).every(([p, h]) => remoteHashes[p] === h), { files: Object.keys(localHashes).length });
    }
    const helpers = Object.fromEntries(Object.entries(runtime.runtimeHashes).filter(([p]) => p.startsWith("scripts/eval/container/")).map(([p,h]) => [p.replace("scripts/eval/container/", ""), h]));
    const helperScript = 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";const names=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify(Object.fromEntries(names.map(p=>[p,createHash("sha256").update(readFileSync("/opt/eval/"+p)).digest("hex")]))));';
    const helperHashes=JSON.parse((await execute(r,["bun","-e",helperScript],JSON.stringify(Object.keys(helpers)))).stdout);
    check("转发器与容器辅助源码逐文件一致",Object.entries(helpers).every(([p,h])=>helperHashes[p]===h),{files:Object.keys(helpers).length});
    const envInput = await execute(r, ["sh", "-c", 'printf checked > /task/write-check; cat /task/write-check; printf "%s" "$HOME"']); check("独立可写目录和HOME", envInput.stdout === "checked/home/eval");
  });
  for (const variant of ["old", "new", "claude"] as const) {
    if (process.env.AXI_RC_STUDY) { const {claimStart} = await import("../rc/config.ts"); claimStart("initial-probe-" + variant, "probe", {batch:batch.id,variant}); }
    await inspect("live-" + variant, async r => {
      const prompt = "在当前目录创建 hello.ts，使 bun run hello.ts 只输出 V1-READY。读取文件确认内容，实际运行并报告。不安装依赖，不联网，不运行后台任务或其他 agent。";
      save(join(r.directory, "input.json"), { variant, prompt });
      const x = await (variant === "new" ? runAxiV1 : variant === "old" ? runAxi : runClaude)(batch, r, [prompt], { maxMs: 120000, ...(variant === "old" ? { axiEntry: "/opt/axi-v0/src/main.ts" } : {}) });
      const run = await execute(r, ["bun", "run", "hello.ts"], undefined, true);
      const events = readFileSync(join(batch.directory, "relay", r.id + ".jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
      const requests = events.filter(e => e.kind === "request" && e.data.path === "/v1/messages").map(e => e.data.body);
      check(variant + "真实模型与执行", x.status === "completed" && x.proxy.faults.length === 0 && run.exitCode === 0 && run.stdout.trim() === "V1-READY", { status: x.status, error: x.error, run });
      check(variant + "模型与effort", requests.length > 0 && requests.every(b => b.model === "claude-opus-5-5" && b.output_config?.effort === "medium") && x.proxy.responses.every((v: any) => v.model === "claude-opus-5-5"), { requests: requests.length });
    }, null);
  }
  complete = true;
} finally {
  const report = { complete, image, batch: batch.id, directory: batch.directory, checks, ...runtime, sourceHash: frozen.sourceHash };
  save(join(batch.directory, "preflight.json"), report); save(join(study, "preflight-latest.json"), report);
  await docker(["rm", "-f", batch.relay], undefined, true);
}
