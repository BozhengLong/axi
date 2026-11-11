import {readFileSync,writeFileSync,mkdirSync,existsSync,statfsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {ROOT,save,initialize,docker,createRuntime,destroyRuntime} from '../core.ts';
import {runAxi,runClaude} from '../adapters.ts';
import {runAxiV1} from './adapter.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {runtimeFingerprint} from './fingerprint.ts';
import {writeTraceIndex} from '../trace.ts';
import {job} from './job.ts';
import {taskFiles,snapshotHash} from './tasks.ts';
import {STUDY,IMAGE,schedule,type TaskId,type Variant} from './settings.ts';
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
if(!['--live','--check'].includes(process.argv[2]??'')||process.env.AXI_EVAL_IMAGE!==IMAGE)throw Error('需 --live 与固定镜像');
const frozen=fingerprint(),runtime=runtimeFingerprint(),freeze=read(join(STUDY,'product-freeze.json'));
const preflight=read(join(STUDY,'preflight-latest.json')),calibration=read(join(STUDY,'calibration-latest.json')),smoke=read(join(STUDY,'pipeline-smoke-latest.json'));
if(runtime.runtimeHash!==freeze.runtimeHash||preflight.runtimeHash!==runtime.runtimeHash||!preflight.complete||preflight.image!==IMAGE)throw Error('冻结实现/前置不一致');
if(!calibration.complete||calibration.results.length!==14||calibration.results.some((r:any)=>!r.passed)||calibration.image!==IMAGE)throw Error('校准未完成');
if(!smoke.complete||smoke.results.length!==8||smoke.results.some((r:any)=>!r.passed)||smoke.image!==IMAGE||smoke.runtimeHash!==runtime.runtimeHash)throw Error('全流水线模拟未完成');
// 逐一校验实际执行组件；新增调度入口不会冒充既有验收器已复测。
const gradeOwner=(p:string)=>p.startsWith('evals/')&&(!p.endsWith('.md')||p.endsWith('/brief.md'))||p.startsWith('scripts/eval/c6/')||p.startsWith('scripts/eval/c7/')||['scripts/eval/v1/grade.ts','scripts/eval/v1/tasks.ts','scripts/eval/v1/runtime.ts','scripts/eval/v1/settings.ts'].includes(p);
for(const p of Object.keys(frozen.hashes)){if(gradeOwner(p)&&calibration.hashes[p]!==frozen.hashes[p])throw Error('校准后验收组件改变：'+p);if((gradeOwner(p)||p==='scripts/eval/v1/job.ts')&&smoke.hashes[p]!==frozen.hashes[p])throw Error('模拟后流水线组件改变：'+p);}
const tasks:TaskId[]=['C7-L','C7-O','V1-A','V1-B'],inputs=Object.fromEntries(tasks.map(t=>[t,snapshotHash(taskFiles(t))]));
for(const row of calibration.results)if(inputs[row.task]!==row.inputSha256)throw Error('校准输入不同');
for(const row of smoke.results)if(inputs[row.task]!==row.result.inputSha256)throw Error('模拟输入不同');
if(process.argv[2]==='--check'){console.log(JSON.stringify({ready:true,image:IMAGE,inputs,calibration:calibration.results.length,smoke:smoke.results.length,runtimeHash:runtime.runtimeHash}));process.exit(0);}
const start=Date.now(),deadline=start+18*3600_000,workDeadline=deadline-30*60_000;
writeFileSync(join(STUDY,'formal.claim'),JSON.stringify({start:new Date(start).toISOString(),deadline:new Date(deadline).toISOString(),sourceHash:frozen.sourceHash,inputs})+'\n',{flag:'wx',mode:0o600});
const batch=await initialize(),results:any[]=[],attempts:any[]=[],selection:any[]=[],health:any[]=[];
let stopReason:string|undefined,recoveryUsed=false;const gitHeads:Record<string,string>={};
save(join(STUDY,'formal-batch.json'),{id:batch.id,directory:batch.directory,deadline:new Date(deadline).toISOString()});
for(const p of Object.keys(frozen.hashes)){const target=join(batch.directory,'source-snapshot',p);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,readFileSync(join(ROOT,p)),{mode:0o600});}
const manifest={batch:batch.id,suite:'v1-three-way-v1',suiteRevision:1,traceVersion:2,created:new Date(start).toISOString(),deadline:new Date(deadline).toISOString(),workDeadline:new Date(workDeadline).toISOString(),maxStarts:23,hostDiskReserveBytes:4*1024**3,image:IMAGE,model:'claude-opus-5-5',effort:'medium',productFreeze:freeze,schedule,inputs,calibration:{directory:calibration.directory,results:calibration.results},smoke:{directory:smoke.directory,results:smoke.results.map((x:any)=>({task:x.task,variant:x.variant,passed:x.passed}))},preflight,...frozen,...runtime};save(join(batch.directory,'manifest.json'),manifest);
const persist=()=>{save(join(batch.directory,'results.json'),results);save(join(batch.directory,'attempts.json'),attempts);save(join(batch.directory,'selection.json'),selection)};
function window(minutes:number){if(Date.now()+minutes*60_000>deadline){stopReason='insufficient_window';return false;}const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<manifest.hostDiskReserveBytes){stopReason='host_disk_headroom';return false;}return true;}
async function once(task:TaskId,variant:Variant,repeat:number,retry=false){
 const id=`formal-${task}-r${repeat}-${variant}${retry?'-retry1':''}`;
 if(attempts.length>=23||Date.now()+45*60_000>workDeadline)throw Error('启动或时间上限');
 if(fingerprint().sourceHash!==frozen.sourceHash||snapshotHash(taskFiles(task))!==inputs[task])throw Error('正式源码或输入改变');
 attempts.push({id,task,variant,repeat,retry,time:new Date().toISOString()});persist();
 let row:any;try{row=await job(batch,task,variant,repeat,id,{deadline:workDeadline});}catch(e){const p=join(batch.directory,id,'result.json');if(existsSync(p))results.push(read(p));persist();throw e;}
 results.push({...row,retry});persist();
 console.log(JSON.stringify({id,status:row.status,classification:row.classification,codePassed:row.codePassed,regressionPassed:row.regressionPassed,requests:row.budget?.generationRequests}));
 if(gitHeads[task]&&gitHeads[task]!==row.initialCommit)throw Error('初始提交不同');gitHeads[task]=row.initialCommit;
 const trace=read(join(batch.directory,id,'trace-manifest.json'));if(trace.status!=='complete_observable')throw Error('Trace 缺失');
 if(['unclassified_failure','evaluation_invalid'].includes(row.classification)||row.status==='runner_error')throw Error('设施或协议异常');return row;
}
async function healthy(){for(const variant of ['old','new','claude'] as const){const id='recovery-health-'+variant,r=await createRuntime(batch,id,{maxRounds:1,maxTotal:5});try{const x=await(variant==='old'?runAxi:variant==='new'?runAxiV1:runClaude)(batch,r,['只回复 V1-READY，不调用工具。'],{maxMs:60000,...(variant==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{})});const passed=x.status==='completed'&&x.turns.join('\n').includes('V1-READY');health.push({id,variant,passed,status:x.status,budget:x.proxy.budget});save(join(batch.directory,'recovery-health.json'),health);if(!passed)return false;}finally{await destroyRuntime(batch,r);}}return true;}
try{
 for(const task of ['C7-L','C7-O'] as const){if(!window(80))break;const row=await once(task,'new',1);selection.push({kind:'known',task,ids:[row.id]});persist();if(row.classification==='environment_indeterminate'){stopReason='known_environment_interruption';break;}}
 if(!stopReason)for(let index=0;index<schedule.length;index++){
  if(!window(180))break;const spec=schedule[index]!,original:any[]=[];
  for(const variant of spec.variants)original.push(await once(spec.task,variant,spec.repeat));
  if(!original.some(r=>r.classification==='environment_indeterminate')){selection.push({kind:'triple',group:index+1,task:spec.task,repeat:spec.repeat,ids:original.map(r=>r.id),retry:false});persist();continue;}
  save(join(batch.directory,`incident-${index+1}.json`),{group:index+1,ids:original.map(r=>r.id),classification:'environment_indeterminate',time:new Date().toISOString()});
  if(recoveryUsed){stopReason='recovery_limit';break;}if(!window(183))break;recoveryUsed=true;
  if(!await healthy()){stopReason='recovery_health_failed';break;}const retry:any[]=[];for(const variant of spec.variants)retry.push(await once(spec.task,variant,spec.repeat,true));
  if(retry.some(r=>r.classification==='environment_indeterminate')){stopReason='recovery_failed';break;}
  selection.push({kind:'triple',group:index+1,task:spec.task,repeat:spec.repeat,ids:retry.map(r=>r.id),retry:true,supersededIds:original.map(r=>r.id)});persist();
 }
}catch(error){stopReason='infrastructure_or_protocol_error';save(join(batch.directory,'run-error.json'),{error:String(error),time:new Date().toISOString()});throw error;}
finally{persist();save(join(batch.directory,'completion.json'),{complete:selection.length===8,starts:attempts.length,graded:results.length,adopted:selection.flatMap(s=>s.ids).length,recoveryUsed,stopReason,time:new Date().toISOString()});writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true);}
console.log(JSON.stringify({batch:batch.id,starts:attempts.length,complete:selection.length===8,stopReason}));
