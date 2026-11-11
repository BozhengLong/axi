import { current, save, type Snapshot } from "./core.ts";
import { tasks } from "./tasks.ts";
import { grade } from "../../evals/oracles/grade.ts";
import type { Execution } from "./adapters.ts";

const pack = (files: Record<string, string>): Snapshot => Object.fromEntries(Object.entries(files).map(([p, t]) => [p, { type: "file", mode: 0o644, data: Buffer.from(t).toString("base64") }]));
const initialStats = `const n=[0,0,0];for(const line of (await Bun.file(process.argv[2]).text()).split(/\\r?\\n/)){const m=line.match(/^- \\[( |~|x)\\](?:[ \\t].*)?$/);if(m)n[[' ','~','x'].indexOf(m[1])]++;}console.log('未开始：'+n[0]+'\\n进行中：'+n[1]+'\\n已完成：'+n[2]);`;
const finalStats = initialStats + `const total=n.reduce((a,b)=>a+b,0);console.log('总数：'+total+'\\n完成率：'+(total?n[2]/total*100:0).toFixed(1)+'%');`;
const parser = `export function summarize(text){const out={todo:0,doing:0,done:0};for(const line of text.replace(/^\\uFEFF/,'').split(/\\r?\\n/)){const m=line.match(/^- \\[( |~|x|X)\\](?:[ \\t].*)?$/);if(m)out[m[1]===' '?'todo':m[1]==='~'?'doing':'done']++;}return out;}if(import.meta.main)console.log(JSON.stringify(summarize(await Bun.file(process.argv[2]).text())));`;
const merge = `import{readdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';function order(a,b){const x=Array.from(a,c=>c.codePointAt(0)),y=Array.from(b,c=>c.codePointAt(0));for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;}try{const input=process.argv[2],output=process.argv[3],m=new Map();for(const f of readdirSync(input,{withFileTypes:true}).filter(d=>d.isFile()&&d.name.endsWith('.json')).map(d=>d.name).sort(order)){const a=JSON.parse(readFileSync(join(input,f),'utf8'));if(!Array.isArray(a))throw Error('array');for(const r of a){if(!r||typeof r.id!=='string'||!r.id||!Number.isSafeInteger(r.amount)||r.amount<0)throw Error('record');m.set(r.id,{id:r.id,amount:r.amount});}}const items=[...m.values()].sort((a,b)=>order(a.id,b.id));const total=items.reduce((n,r)=>n+r.amount,0);if(!Number.isSafeInteger(total))throw Error('total');writeFileSync(output,JSON.stringify({items,total}));}catch(e){console.error(String(e));process.exitCode=1;}`;
const b = current(), results = [];
for (const task of tasks()) {
  const files = { ...task.files };
  if (task.id === "T2") files["stats.ts"] = finalStats;
  if (task.id === "T3") files["parser.ts"] = parser;
  if (task.id === "T4") files["merge.ts"] = merge;
  const data = Object.entries(task.files).filter(([p]) => p.startsWith("data/"));
  const execution: Execution = { status: "completed", wallMs: 0, turns: task.id === "T1" ? [JSON.stringify({ fileCount: data.length, totalBytes: data.reduce((n, [, v]) => n + Buffer.byteLength(v), 0), project: "青松", owner: "林舟", deadline: "2026-12-01" })] : ["完成"], snapshots: [pack(task.files), pack({ ...task.files, "stats.ts": initialStats })], proxy: {}, stdoutPath: "self-check" };
  const positive = await grade(b, `oracle-positive-${task.id}`, task, execution, pack(files));
  const broken: Record<string, string> = { ...files, "brief.md": "tampered\n" };
  if (task.id === "T2") broken["stats.ts"] = 'console.log("未开始：999")';
  if (task.id === "T3") broken["parser.ts"] = task.files["parser.ts"]!;
  if (task.id === "T4") broken["merge.ts"] = 'console.log("完成")';
  const negative = await grade(b, `oracle-negative-${task.id}`, task, execution, pack(broken));
  const result = { task: task.id, positiveAccepted: positive.pass, negativeRejected: !negative.pass, positive, negative };
  results.push(result); console.log(JSON.stringify({ task: task.id, positiveAccepted: positive.pass, negativeRejected: !negative.pass, failedPositive: positive.checks.filter(c => !c.pass) }));
}
save(b.directory + "/oracle-selfcheck.json", results);
if (!results.every(r => r.positiveAccepted && r.negativeRejected)) process.exitCode = 1;
