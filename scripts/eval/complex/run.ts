import {readFileSync,existsSync,mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {current,createRuntime,destroyRuntime,snapshot,save,ROOT,type Runtime} from "../core.ts";
import {runAxi,runClaude} from "../adapters.ts";
import {complexTasks} from "./tasks.ts";
import {gradeComplex} from "./grade.ts";
import {fingerprint} from "./fingerprint.ts";
import {prepareWorkspace} from "./workspace.ts";
import {modelSettingsMatch,transportSummary} from "./settings.ts";
import {writeTraceIndex} from "../trace.ts";
if(!process.argv.includes("--live"))throw Error("需要 --live");
const phase=process.argv.includes("--formal")?"formal":"pilot",repetitions=phase==="pilot"?1:3;
const b=current(),gate=JSON.parse(readFileSync(join(b.directory,"preflight.json"),"utf8")),calibration=JSON.parse(readFileSync(join(b.directory,"complex-calibration.json"),"utf8"));
if(!gate.pass||!gate.complete||!gate.live||!gate.complex||gate.image!==b.image||!calibration.pass||!calibration.complete||calibration.image!==b.image)throw Error("前置或任务校准未通过");
const frozen=fingerprint();if(gate.sourceHash!==frozen.sourceHash)throw Error("前置检查后源码发生变化");if(calibration.sourceHash!==frozen.sourceHash)throw Error("任务或控制器在校准后变化，需重新校准");
const selected=complexTasks();let seed=20261111;
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;}
const pairs=selected.flatMap(t=>Array.from({length:repetitions},(_,i)=>({task:t.id,repeat:i+1})));
for(let i=pairs.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pairs[i],pairs[j]]=[pairs[j]!,pairs[i]!];}
const schedule=pairs.flatMap((pair,i)=>(i%2===0?["axi","claude"]:["claude","axi"]).map(agent=>({...pair,agent,id:`${phase}-${String(i+1).padStart(2,"0")}-${pair.task}-r${pair.repeat}-${agent}`})));
const deadline=Date.parse(process.env.AXI_EVAL_DEADLINE??"");
if(!Number.isFinite(deadline))throw Error("请通过 AXI_EVAL_DEADLINE 明确本次截止时间（UTC ISO 格式）");
const manifest={batch:b.id,suite:"complex-v1",suiteRevision:3,phase,traceVersion:2,sourceSnapshot:"source-snapshot",created:new Date().toISOString(),image:b.image,seed:20261111,model:"claude-opus-5-5",effort:"medium",maxMs:1800000,maxRequests:50,deadline:new Date(deadline).toISOString(),...frozen,schedule,preflight:gate,calibration:calibration.results.map((r:any)=>({task:r.task,variant:r.variant,id:r.id,accepted:r.accepted})),taskPrompts:selected.map(t=>({id:t.id,prompts:t.prompts}))};
const manifestPath=join(b.directory,"manifest.json");
if(existsSync(manifestPath)){const old=JSON.parse(readFileSync(manifestPath,"utf8"));if(old.sourceHash!==frozen.sourceHash||old.phase!==phase)throw Error("禁止混用既有批次");}
else{for(const name of Object.keys(frozen.hashes)){const target=join(b.directory,"source-snapshot",name);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,readFileSync(join(ROOT,name)),{mode:0o600,flag:"wx"});}save(manifestPath,manifest);}
const results:any[]=[];let stopped:string|undefined;
for(const [index,entry] of schedule.entries()){
 const path=join(b.directory,entry.id+"-result.json");if(existsSync(path)){results.push(JSON.parse(readFileSync(path,"utf8")));continue;}
 if(index%2===0&&Date.now()+2*1800000+120000+30*60000>deadline){stopped="时间预算不足以保证完成下一对运行并整理报告";break;}
 if(fingerprint().sourceHash!==frozen.sourceHash)throw Error("冻结内容发生变化，暂停");
 const task=selected.find(t=>t.id===entry.task)!;
 console.log(JSON.stringify({event:"start",index:index+1,total:schedule.length,...entry}));
 let runtime:Runtime|undefined;let pause:string|undefined;
 try{
  runtime=await createRuntime(b,entry.id,{files:task.files});
  await prepareWorkspace(runtime);
  const execution=await(entry.agent==="axi"?runAxi:runClaude)(b,runtime,task.prompts,{maxMs:1800000});
  const final=await snapshot(runtime);save(join(runtime.directory,"final-files.json"),final);
  const verdict=await gradeComplex(b,entry.id,task,execution,final);
  const events=readFileSync(join(b.directory,"relay",entry.id+".jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  const requests=events.filter(e=>e.kind==="request").map(e=>e.data.body);
  const modelMatched=modelSettingsMatch(events,execution.proxy.responses);
  const transport=transportSummary(events,execution.proxy.transportIssues??[]);
  const infrastructureFaults=execution.proxy.faults.filter((f:string)=>f!=="request_budget");
  const usage:Record<string,number>={};for(const r of execution.proxy.responses)for(const k of ["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"])usage[k]=(usage[k]??0)+(r.usage[k]??0);
  const result={...entry,phase,status:execution.status,pass:verdict.pass&&modelMatched&&!execution.proxy.faults.length,modelMatched,faults:execution.proxy.faults,transportIssues:transport.issues,httpErrors:transport.httpErrors,error:execution.error,wallMs:execution.wallMs,requests:requests.length,deniedBudgetRequests:Math.max(0,execution.proxy.requests-requests.length),tools:execution.proxy.tools.length,permissions:execution.proxy.permissions.length,usage,checks:verdict.checks,finished:new Date().toISOString()};
  save(path,result);results.push(result);save(join(b.directory,"results.json"),results);
  console.log(JSON.stringify({event:"result",index:results.length,task:entry.task,repeat:entry.repeat,agent:entry.agent,pass:result.pass,status:result.status,seconds:+(result.wallMs/1000).toFixed(1),requests:result.requests,failedChecks:result.checks.filter(c=>!c.pass).map(c=>c.name),faults:result.faults}));
  if(!modelMatched||infrastructureFaults.length||["runner_error","product_or_runner_error"].includes(result.status)||verdict.checks.some(c=>c.name==="验收环境完成"&&!c.pass))pause="控制器、模型配置或设施异常，已留证，需定位后新建批次";
 }finally{if(runtime)await destroyRuntime(b,runtime);}
 if(runtime){const trace=JSON.parse(readFileSync(join(runtime.directory,"trace-manifest.json"),"utf8"));if(trace.status!=="complete_observable")pause=`Trace 未收齐：${trace.missing.join("、")}`;}
 writeTraceIndex(b.directory);
 if(pause)throw Error(pause);
}
if(fingerprint().sourceHash!==frozen.sourceHash)throw Error("完成时冻结内容发生变化");
save(join(b.directory,"completion.json"),{completed:results.length===schedule.length,count:results.length,expected:schedule.length,stopped,time:new Date().toISOString()});
console.log(JSON.stringify({event:"completed",batch:b.id,phase,runs:results.length,expected:schedule.length,stopped,axiPassed:results.filter(r=>r.agent==="axi"&&r.pass).length,claudePassed:results.filter(r=>r.agent==="claude"&&r.pass).length}));
