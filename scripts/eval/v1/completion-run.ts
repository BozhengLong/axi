import {readFileSync,writeFileSync,mkdirSync,existsSync,statfsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {ROOT,save,initialize,createRuntime,destroyRuntime,docker} from '../core.ts';
import {runAxi,runClaude} from '../adapters.ts';
import {runAxiV1} from './adapter.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {runtimeFingerprint} from './fingerprint.ts';
import {writeTraceIndex} from '../trace.ts';
import {taskFiles,snapshotHash} from './tasks.ts';
import {job} from './job.ts';
import {STUDY,IMAGE,schedule,type TaskId,type Variant} from './settings.ts';

const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
if(!['--check','--live'].includes(process.argv[2]??'')||!process.env.AXI_V1_STUDY||process.env.AXI_EVAL_IMAGE!==IMAGE)throw Error('补全轮次需要独立study、固定image及显式执行方式');
const authorization=read(join(STUDY,'authorization.json'));
if(authorization.plan!=='v1-completion-D1-D3'||authorization.confirmedBy!=='user'||authorization.maxStarts!==21||authorization.plannedStarts!==18||authorization.image!==IMAGE)throw Error('不是本轮已确认的预算');
const deadline=Date.parse(authorization.deadline),workDeadline=deadline-30*60_000;
if(!Number.isFinite(deadline)||deadline-Date.parse(authorization.start)>18*3600_000||deadline<=Date.now())throw Error('截止不合法或已到期');
const frozen=fingerprint(),runtime=runtimeFingerprint(),origin=read(join(STUDY,'product-origin-freeze.json'));
for(const [path,hash] of Object.entries(origin.runtimeHashes))if(path.startsWith('src/')&&frozen.hashes[path]!==hash)throw Error('产品冻结后发生改变：'+path);
const calibration=read(join(STUDY,'calibration-latest.json')),pipeline=read(join(STUDY,'pipeline-smoke-latest.json')),interaction=read(join(STUDY,'smoke-latest.json')),transport=read(join(STUDY,'transport-smoke-latest.json')),preflight=read(join(STUDY,'preflight-latest.json'));
for(const [name,report,count,key] of [['校准',calibration,14,'results'],['流水线',pipeline,8,'results'],['交互',interaction,9,'checks'],['传输',transport,7,'results']] as const){
 if(!report.complete||report.image!==IMAGE||report.sourceHash!==frozen.sourceHash||report[key].length!==count||report[key].some((r:any)=>!r.passed))throw Error(name+'未通过或不是当前冻结源码');
}
if(!preflight.complete||preflight.image!==IMAGE||preflight.sourceHash!==frozen.sourceHash||preflight.runtimeHash!==runtime.runtimeHash||preflight.checks.some((r:any)=>!r.pass))throw Error('完整前置未通过');
if(calibration.results.filter((r:any)=>r.task.startsWith('V1-')&&r.kind==='reference').some((r:any)=>r.publicRecipes?.length!==4||r.publicRecipes.some((c:any)=>c.exitCode!==0)))throw Error('公开命令校准缺失');
const inputs=Object.fromEntries(['V1-A','V1-B'].map(t=>[t,snapshotHash(taskFiles(t as TaskId))]));
for(const row of calibration.results)if(row.task in inputs&&row.inputSha256!==inputs[row.task])throw Error('校准输入不一致');
for(const row of pipeline.results)if(row.task in inputs&&row.result.inputSha256!==inputs[row.task])throw Error('流水线输入不一致');
if(process.argv[2]==='--check'){console.log(JSON.stringify({ready:true,study:STUDY,image:IMAGE,inputs,sourceHash:frozen.sourceHash,deadline:authorization.deadline,maxStarts:21}));process.exit(0);}
writeFileSync(join(STUDY,'formal.claim'),JSON.stringify({created:new Date().toISOString(),deadline:authorization.deadline,sourceHash:frozen.sourceHash,inputs})+'\n',{flag:'wx',mode:0o600});
const batch=await initialize(),results:any[]=[],attempts:any[]=[],selection:any[]=[],health:any[]=[];
let recoveryUsed=false,stopReason:string|undefined;
const heads:Record<string,string>={};
save(join(STUDY,'formal-batch.json'),{id:batch.id,directory:batch.directory,deadline:authorization.deadline});
for(const path of Object.keys(frozen.hashes)){const target=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,readFileSync(join(ROOT,path)),{mode:0o600});}
save(join(batch.directory,'manifest.json'),{batch:batch.id,suite:'v1-completion-v1',traceVersion:2,authorization,image:IMAGE,productCommit:authorization.productCommit,model:'claude-opus-5-5',effort:'medium',deadline:authorization.deadline,workDeadline:new Date(workDeadline).toISOString(),schedule,inputs,priorKnownRegressions:join(authorization.sourceStudy,'reviews.json'),preflight,calibration:{directory:calibration.directory,results:calibration.results},pipeline:{directory:pipeline.directory},transport:{directory:transport.directory},...frozen,...runtime});
const persist=()=>{save(join(batch.directory,'results.json'),results);save(join(batch.directory,'attempts.json'),attempts);save(join(batch.directory,'selection.json'),selection);};
function enoughWindow(minutes:number){if(Date.now()+minutes*60_000>deadline){stopReason='insufficient_triple_window';return false;}const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3){stopReason='host_disk_headroom';return false;}return true;}
async function runOne(task:TaskId,variant:Variant,repeat:number,retry:boolean){
 if(attempts.length>=21||Date.now()+45*60_000>workDeadline)throw Error('预算或截止不允许启动');
 if(fingerprint().sourceHash!==frozen.sourceHash||snapshotHash(taskFiles(task))!==inputs[task])throw Error('正式源码或输入在运行中改变');
 const id=`formal-${task}-r${repeat}-${variant}${retry?'-retry1':''}`;
 attempts.push({id,task,variant,repeat,retry,time:new Date().toISOString()});persist();
 let row:any;
 try{row=await job(batch,task,variant,repeat,id,{deadline:workDeadline});}
 catch(error){const p=join(batch.directory,id,'result.json');if(existsSync(p))results.push(read(p));persist();throw error;}
 results.push({...row,retry});persist();
 console.log(JSON.stringify({id,status:row.status,classification:row.classification,codePassed:row.codePassed,regressionPassed:row.regressionPassed,requests:row.forwardedGenerationRequests}));
 if(heads[task]&&heads[task]!==row.initialCommit)throw Error('同题初始Git提交不同');heads[task]=row.initialCommit;
 if(read(join(batch.directory,id,'trace-manifest.json')).status!=='complete_observable')throw Error('Trace缺失');
 if(['unclassified_failure','evaluation_invalid'].includes(row.classification)||row.status==='runner_error')throw Error('设施或协议问题，停止本轮');
 return row;
}
async function recoveryHealth(){
 for(const variant of ['old','new','claude'] as const){const id=`recovery-health-${variant}`,r=await createRuntime(batch,id,{maxRounds:1,maxTotal:5});let passed=false;
  try{const x=await(variant==='old'?runAxi:variant==='new'?runAxiV1:runClaude)(batch,r,['只回复 V1-READY，不调用工具。'],{maxMs:60000,...(variant==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{})});passed=x.status==='completed'&&x.turns.join('\n').includes('V1-READY');health.push({id,variant,passed,status:x.status,budget:x.proxy.budget});save(join(batch.directory,'recovery-health.json'),health);}
  finally{await destroyRuntime(batch,r);}if(!passed||read(join(r.directory,'trace-manifest.json')).status!=='complete_observable')return false;
 }return true;
}
try{
 for(let group=0;group<schedule.length;group++){
  if(!enoughWindow(180))break;const spec=schedule[group]!,original:any[]=[];
  for(const variant of spec.variants)original.push(await runOne(spec.task,variant,spec.repeat,false));
  if(!original.some(r=>r.classification==='environment_indeterminate')){selection.push({group:group+1,task:spec.task,repeat:spec.repeat,ids:original.map(r=>r.id),retry:false});persist();continue;}
  save(join(batch.directory,`environment-group-${group+1}.json`),{ids:original.map(r=>r.id),time:new Date().toISOString(),sourceHash:frozen.sourceHash});
  if(recoveryUsed){stopReason='recovery_limit';break;}if(!enoughWindow(183))break;recoveryUsed=true;
  if(!await recoveryHealth()){stopReason='recovery_health_failed';break;}
  const replacement:any[]=[];for(const variant of spec.variants)replacement.push(await runOne(spec.task,variant,spec.repeat,true));
  if(replacement.some(r=>r.classification==='environment_indeterminate')){stopReason='recovery_failed';break;}
  selection.push({group:group+1,task:spec.task,repeat:spec.repeat,ids:replacement.map(r=>r.id),retry:true,supersededIds:original.map(r=>r.id)});persist();
 }
}catch(error){stopReason='infrastructure_or_protocol_error';save(join(batch.directory,'run-error.json'),{error:String(error),time:new Date().toISOString()});throw error;}
finally{persist();save(join(batch.directory,'completion.json'),{complete:selection.length===6,starts:attempts.length,graded:results.length,adopted:selection.length*3,recoveryUsed,stopReason,time:new Date().toISOString()});writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true);}
console.log(JSON.stringify({batch:batch.id,starts:attempts.length,complete:selection.length===6,stopReason}));
