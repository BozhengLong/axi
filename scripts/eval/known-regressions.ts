import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { current, save, command, ROOT } from "./core.ts";
import { SessionLog } from "../../src/log.ts";

// 只复现既有缺陷。R1 不执行待确认命令；R2 只连本机；R3 使用虚构日志。
const results: any[] = [];
const script = `import{Terminal}from"${ROOT}/src/ui/terminal.ts";import{confirmCommand}from"${ROOT}/src/ui/permission.ts";const ui=new Terminal();ui.write("READY\\n");setTimeout(async()=>{const p=await confirmCommand("printf unused","/synthetic",ui.read,ui.write,new AbortController().signal);ui.write("RESULT="+JSON.stringify(p)+"\\n");ui.close();},500);`;
let out = "", entered = false, submitted = false, reasonSent = false;
const p = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { env: { ...process.env, TERM: "xterm-256color" }, terminal: { data(t, bytes) {
  out += new TextDecoder().decode(bytes);
  if (!entered && out.includes("READY")) { entered = true; t.write("y\x01"); }
  if (!submitted && out.includes("执行这次调用？[y/N] ")) { submitted = true; t.write("\r"); }
  if (!reasonSent && out.includes("拒绝理由（选填，回车跳过）：")) { reasonSent = true; t.write("\r"); }
} } });
const timeout = setTimeout(() => p.kill("SIGKILL"), 5000);
await p.exited; clearTimeout(timeout); p.terminal?.close();
const result = out.match(/RESULT=(\{[^\r\n]+\})/);
const allowed = result ? JSON.parse(result[1]!).allowed : undefined;
results.push({ id: "R1", defectReproduced: allowed === true, verified: allowed !== undefined, expected: "allowed=false", actual: allowed === undefined ? "未取得确认结果" : `allowed=${allowed}`, commandExecuted: false });

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (/^(http|https|all|no)_proxy$/i.test(key)) delete cleanEnv[key];
const netScript = `import{APIClient}from"${ROOT}/src/api/client.ts";const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response("")}});const url="http://127.0.0.1:"+s.port+"/v1/messages";s.stop(true);let calls=0,kind="";const c=new APIClient({url,apiKey:"fake",model:"fake",timeoutMs:1000},"",{fetch:async(...args)=>{calls++;try{return await fetch(...args)}catch(e){kind=e.constructor.name+":"+e.code;throw e}},sleep:async()=>{}});try{await c.call([],{effort:"medium",signal:AbortSignal.timeout(5000)})}catch{}console.log(JSON.stringify({calls,kind}));`;
const child = Bun.spawn([process.execPath, "--no-env-file", "-e", netScript], { env: cleanEnv, stdout: "pipe", stderr: "pipe" });
const response = JSON.parse(await new Response(child.stdout).text()); await child.exited;
results.push({ id: "R2", defectReproduced: response.calls === 1, expected: "连接失败重试至最多 4 次请求", actual: response });
const dir = mkdtempSync(join(tmpdir(), "axi-regression-"));
try {
  await command(["git", "init", "-q", dir]);
  const log = new SessionLog(dir); log.record("request", { content: "synthetic" }); log.close();
  const status = await command(["git", "-C", dir, "status", "--short", "--untracked-files=all"]);
  results.push({ id: "R3", defectReproduced: status.stdout.includes(".axi/logs/"), expected: "日志不进入待提交文件", actual: status.stdout.replace(/[^ /]+\.jsonl/, "<session>.jsonl") });
} finally { rmSync(dir, { recursive: true, force: true }); }
save(current().directory + "/known-regressions.json", results);
console.log(JSON.stringify(results));
