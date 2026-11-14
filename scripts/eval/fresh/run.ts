import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync,existsSync,statfsSync} from 'node:fs';
import {ROOT,initialize,save,docker,createRuntime,destroyRuntime} from '../core.ts';
import {runAxi,runClaude} from '../adapters.ts';
import {runAxiV1} from '../v1/adapter.ts';
import {taskFiles} from '../v1/tasks.ts';
import type {Variant} from '../v1/settings.ts';
import {executeCandidate,exclusive} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {claimStart} from '../review/config.ts';
import {profile} from './profile.ts';
import {gates} from './gates.ts';
import {gradeInWorker,GradeInfrastructureError} from './grading.ts';
import {grade} from './grade.ts';
import {reference} from './tasks.ts';
import {recoverGrades} from './recovery.ts';
import {disposition,groupDecision} from './control.ts';
import {FRESH,STUDY,IMAGE,read,schedule,type FreshTask} from './settings.ts';
const mode=process.argv[2];if(!['--check','--live','--resume'].includes(mode??''))throw Error('需要 --check/--live/--resume');
const p=profile(),a=p.authorization,statePath=join(FRESH,'state.json');let state:any;
if(mode==='--resume')state=await recoverGrades();else{
 const ready=gates();if(mode==='--check'){console.log(JSON.stringify({ready:true,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,deadline:a.deadline}));process.exit(0)}
 exclusive(join(FRESH,'formal.claim'),{started:new Date().toISOString(),profile:p.executionProfileHash,deadline:a.deadline});
 state={phase:'running',authorization:a,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash,graderRevision:p.graderRevision,rows:[],attempts:[],selection:[],retryGroups:[],upstreamRecoveryUsed:false,gradeRecoveryUsed:false,probes:[],batches:[],gates:ready};
}
if(state.authorization.startedAt!==a.startedAt||state.authorization.deadline!==a.deadline||state.authorization.maxStarts!==a.maxStarts)throw Error('不能重置授权');
const persist=()=>save(statePath,state);if(state.stopReason){state.previousStopReason=state.stopReason;delete state.stopReason}state.phase='running';persist();
const batch=await initialize();state.batches.push({id:batch.id,directory:batch.directory});state.batch=batch.id;state.directory=batch.directory;persist();
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'v1-fresh-formal',traceVersion:2,batch:batch.id,image:IMAGE,...p});
function unchanged(){const now=profile();if(now.executionProfileHash!==p.executionProfileHash||now.oracleHash!==p.oracleHash||now.graderRevision!==p.graderRevision)throw Error('正式冻结后执行、输入或评分版本改变')}
async function one(task:FreshTask,variant:Variant,repeat:number,retry:boolean){
 unchanged();const id=`formal-${task}-r${repeat}-${variant}${retry?'-retry1':''}`;let row=state.rows.find((r:any)=>r.execution.id===id);
 if(!row){
  if(state.attempts.some((r:any)=>r.id===id))throw Error('已有启动未封存，不重复执行');
  claimStart(id,'formal',{task,variant,repeat,retry,batch:batch.id,profile:p.executionProfileHash});state.attempts.push({id,task,variant,repeat,retry,time:new Date().toISOString()});persist();
  const execution=await executeCandidate(batch,task,variant,repeat,id,p.executionProfileHash,{deadline:a.workDeadline,...(variant==='new'?{reviewMode:'auto',observeReview:true}:{})});
  const prior=state.rows.find((r:any)=>r.execution.task===task);if(prior&&prior.execution.initialCommit!==execution.initialCommit)throw Error('同题Git初态不一致');
  row={execution,reviewMode:variant==='new'?'auto':variant==='old'?'off':'native'};state.rows.push(row);persist();
 }
 const decision=disposition(row.execution.classification);if(decision==='stop')throw Error('鉴权、协议、隔离或证据异常：'+row.execution.classification);
 if(decision==='upstream'){row.score={gradeStatus:'not_applicable',codePassed:null,regressionPassed:null,fullDeliveryPassed:null,reason:'已识别临时上游故障，不当作代码失败'};persist();return row.execution}
 if(row.score?.gradeStatus==='complete'&&row.score.failureChecks.some((id:string)=>['PROTECT','GIT'].includes(id)))throw Error('已评分产物有保护/Git违规，不继续');
 if(row.score?.gradeStatus!=='complete'){
  state.phase='grading';persist();const deadline=Math.min(Date.now()+15*60000,a.workDeadline);
  row.score=await gradeInWorker(row.execution.runDirectory,FRESH,p.graderRevision,p.executionProfileHash,deadline);persist();if(row.score.gradeStatus!=='complete')throw new GradeInfrastructureError('评分不可判定');
  if(row.score.failureChecks.some((id:string)=>['PROTECT','GIT'].includes(id)))throw Error('保护文件或Git违规，停止新增运行');
  if(existsSync(join(row.execution.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(row.execution.runDirectory,FRESH,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');persist();if(row.checkpointScore.gradeStatus!=='complete')throw new GradeInfrastructureError('检查点评分不可判定')}
  state.phase='running';persist();console.log(JSON.stringify({id,status:row.execution.executionStatus,code:row.score.codePassed,regression:row.score.regressionPassed,failureChecks:row.score.failureChecks,requests:row.execution.forwardedGenerationRequests,checkpointCode:row.checkpointScore?.codePassed}));
 }
 return row.execution;
}
async function health(){
 for(const variant of ['old','new','claude']as const){
  unchanged();const id='fresh-recovery-health-'+variant;claimStart(id,'probe',{variant,batch:batch.id,profile:p.executionProfileHash});
  const runtime=await createRuntime(batch,id,{maxRounds:1,maxTotal:12});let passed=false;
  try{const x=await(variant==='old'?runAxi:variant==='new'?runAxiV1:runClaude)(batch,runtime,['只回复 V1-READY，不调用工具。'],{maxMs:120000,...(variant==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{}),...(variant==='new'?{reviewMode:'auto',observeReview:true}:{})});passed=x.status==='completed'&&x.turns.join('\n').includes('V1-READY');save(join(runtime.directory,'health.json'),{passed});}
  finally{await destroyRuntime(batch,runtime)}
  const trace=read(join(runtime.directory,'trace-manifest.json'));state.probes.push({id,variant,passed,directory:runtime.directory,trace:trace.status});persist();if(!passed||trace.status!=='complete_observable')throw Error('整组恢复前探针未通过');
 }
}
try{
 for(let i=0;i<schedule.length;i++){
  if(state.selection.some((s:any)=>s.group===i+1))continue;unchanged();
  if(Date.now()+140*60000>a.workDeadline)throw Error('完整三方及准备封存窗口不足');const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3)throw Error('宿主归档余量不足');
  const spec=schedule[i]!,healthPath=join(FRESH,'group-health',p.graderRevision,String(i+1));
  if(!existsSync(join(healthPath,'grade.json'))){const g=await grade(spec.task,'fresh-health-'+Date.now(),taskFiles(spec.task),reference(spec.task),healthPath,{regression:false,upstream:false,deadline:a.workDeadline});if(!g.codePassed)throw Error('组前参考健康检查失败')}
  const originals=[];for(const variant of spec.variants)originals.push(await one(spec.task,variant,spec.repeat,false));
  let adopted=originals,retry=state.retryGroups.includes(i+1);
  if(!retry){const next=groupDecision(originals,state.upstreamRecoveryUsed,a.workDeadline-Date.now());if(next==='retry_whole_group'){state.upstreamRecoveryUsed=true;persist();await health();state.retryGroups.push(i+1);persist();retry=true}else if(next!=='adopt')throw Error('三方组停止：'+next)}
  if(retry){
   adopted=[];for(const variant of spec.variants)adopted.push(await one(spec.task,variant,spec.repeat,true));
   if(groupDecision(adopted,true,a.workDeadline-Date.now())!=='adopt')throw Error('整组恢复未取得三个可采用样本');
  }
  state.selection.push({group:i+1,task:spec.task,repeat:spec.repeat,ids:adopted.map(x=>x.id),retry,...(retry?{supersededIds:originals.map(x=>x.id)}:{})});persist();
 }
 state.phase='manual_review_required';
}catch(error){state.phase=state.phase==='grading'&&error instanceof GradeInfrastructureError&&!existsSync(join(STUDY,'grade-recovery.claim'))&&Date.now()<a.workDeadline?'grade_repair_required':'stopped';state.stopReason=String(error);save(join(FRESH,'error-'+Date.now()+'.json'),{error:String(error),phase:state.phase})}
finally{state.finished=new Date().toISOString();persist();save(join(batch.directory,'results.json'),state.rows.filter((r:any)=>r.execution.runDirectory.startsWith(batch.directory+'/')).map((r:any)=>r.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,starts:state.attempts.length,adoptedGroups:state.selection.length,reason:state.stopReason}));
