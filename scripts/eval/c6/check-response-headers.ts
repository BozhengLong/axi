import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { docker, save, ROOT } from "../core.ts";
import { STUDY } from "./settings.ts";
import { hash } from "./task.ts";

// 真实 HTTP 链路：冻结 Axi APIClient → 评测转发器 → 合成服务。没有真实模型请求。
const image = "axi-eval-c6:formal-revision2", directory = join(STUDY, "response-header-check");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const formal = JSON.parse(readFileSync(join(STUDY, "formal-batch.json"), "utf8"));
const sources = {
  old: readFileSync(join(formal.directory, "source-snapshot/scripts/eval/container/relay.ts"), "utf8"),
  new: readFileSync(join(ROOT, "scripts/eval/container/relay.ts"), "utf8"),
  helper: readFileSync(join(ROOT, "scripts/eval/container/response-headers.ts"), "utf8"),
};
for (const [kind, text] of Object.entries(sources)) { const path = join(directory, `${kind}.ts`); writeFileSync(path, text, { mode: 0o444 }); chmodSync(path, 0o444); }
const event = (type: string, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const wire = event("message_start", { message: { id: "msg_probe", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
  + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "header-probe-ok" } })
  + event("content_block_stop", { index: 0 })
  + event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
  + event("message_stop");
const gateway = `let calls=0;Bun.serve({port:8788,hostname:'0.0.0.0',fetch(req){if(req.headers.get('x-api-key')!=='synthetic-upstream-key')return new Response('denied',{status:403});calls++;if(calls===1)return new Response(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'synthetic limit'}}),{status:429,headers:{'content-type':'application/json','retry-after':'7','request-id':'req-limit','anthropic-ratelimit-requests-remaining':'0','x-api-key':'synthetic-upstream-key','set-cookie':'session=synthetic'}});return new Response(${JSON.stringify(wire)},{headers:{'content-type':'text/event-stream','request-id':'req-success','anthropic-ratelimit-requests-remaining':'1'}})}});`;
const client = `import {APIClient} from '/opt/axi/src/api/client.ts';
const base='http://relay:8787';let ready=false;
for(let i=0;i<50;i++){try{await fetch(base+'/ready',{signal:AbortSignal.timeout(500)});ready=true;break}catch{await Bun.sleep(100)}}
if(!ready)throw new Error('relay not ready');
const registration=await fetch(base+'/control/register',{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify({id:'probe',token:'synthetic-client-token'})});
if(!registration.ok)throw new Error('register failed');
const delays=[],seen=[];let raw='';const actualFetch=fetch;
const api=new APIClient({url:base+'/v1/messages',apiKey:'synthetic-client-token',model:'claude-opus-5-5',timeoutMs:5000},'header probe',{maxRetries:1,sleep:async ms=>{delays.push(ms)},fetch:async(...args)=>{const r=await actualFetch(...args);seen.push({status:r.status,retryAfter:r.headers.get('retry-after'),requestId:r.headers.get('request-id'),remaining:r.headers.get('anthropic-ratelimit-requests-remaining'),cookie:r.headers.get('set-cookie'),key:r.headers.get('x-api-key')});if(r.ok)raw=await r.clone().text();return r}});
const result=await api.call([{role:'user',content:'probe'}],{signal:new AbortController().signal,effort:'medium'});
console.log(JSON.stringify({delays,seen,raw,stopReason:result.stopReason,content:result.content}));`;
const results: any[] = [], stamp = Date.now().toString(36);
for (const kind of ["old", "new"] as const) {
  const prefix = `axi-header-${stamp}-${kind}`, network = prefix + "-net", upstream = prefix + "-upstream", relay = prefix + "-relay";
  await docker(["network", "create", "--internal", "--label", "axi.eval.study=c6-header-check", network]);
  try {
    await docker(["run", "-d", "--name", upstream, "--label", "axi.eval.study=c6-header-check", "--network", network, "--network-alias", "upstream", "--read-only", "--user", "1000:1000", "--cap-drop=ALL", "--memory", "256m", "--entrypoint", "bun", image, "-e", gateway]);
    await docker(["run", "-d", "--name", relay, "--label", "axi.eval.study=c6-header-check", "--network", network, "--network-alias", "relay", "--read-only", "--user", "1000:1000", "--cap-drop=ALL", "--memory", "256m", "--tmpfs", "/evidence:rw,nosuid,size=16m,mode=1777", "--mount", `type=bind,src=${join(directory, kind + ".ts")},dst=/opt/eval/relay.ts,readonly`, ...(kind === "new" ? ["--mount", `type=bind,src=${join(directory, "helper.ts")},dst=/opt/eval/response-headers.ts,readonly`] : []), "-e", "EVAL_ADMIN_TOKEN=synthetic-admin", "-e", "EVAL_UPSTREAM_URL=http://upstream:8788/v1/messages", "-e", "EVAL_UPSTREAM_KEY=synthetic-upstream-key", "--entrypoint", "bun", image, "/opt/eval/relay.ts"]);
    const response = await docker(["run", "--rm", "--network", network, "--read-only", "--user", "1000:1000", "--cap-drop=ALL", "--memory", "256m", "--entrypoint", "bun", image, "-e", client], undefined, true, 30000);
    if (response.exitCode) throw new Error(response.stderr + (await docker(["logs", relay], undefined, true)).stdout);
    const observed = JSON.parse(response.stdout);
    const log = (await docker(["exec", relay, "cat", "/evidence/probe.jsonl"])).stdout;
    writeFileSync(join(directory, `${kind}-relay.jsonl`), log, { mode: 0o600 });
    const events = log.trim().split("\n").map(l => JSON.parse(l));
    const headerEvents = events.filter(e => e.kind === "response_headers");
    const passed = JSON.stringify(observed.delays) === JSON.stringify(kind === "new" ? [7000] : [1000])
      && observed.raw === wire && observed.stopReason === "end_turn" && observed.content[0]?.text === "header-probe-ok"
      && observed.seen.every((x: any) => x.cookie === null && x.key === null)
      && (kind === "old" ? headerEvents.length === 0 && observed.seen[0].retryAfter === null : observed.seen[0].retryAfter === "7" && observed.seen[0].requestId === "req-limit" && observed.seen[1].requestId === "req-success" && observed.seen[0].remaining === "0" && headerEvents.length === 2 && headerEvents[0].data.sequence === 1 && headerEvents[1].data.sequence === 2);
    const result = { kind, passed, delays: observed.delays, seen: observed.seen, sseBytesPreserved: observed.raw === wire, headerEvents: headerEvents.map(e => e.data), relaySourceSha256: hash(sources[kind]) };
    results.push(result); save(join(directory, `${kind}-result.json`), result); console.log(JSON.stringify(result));
    if (!passed) throw new Error("响应头端到端回归失败");
  } finally {
    await docker(["rm", "-f", relay, upstream], undefined, true);
    await docker(["network", "rm", network], undefined, true);
  }
}
save(join(STUDY, "response-headers-preflight.json"), { complete: true, passed: results.every(r => r.passed), modelRequests: 0, image, results });
