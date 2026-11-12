import{join,dirname}from'node:path';
import{readFileSync,writeFileSync,mkdirSync,statfsSync,existsSync}from'node:fs';
import{ROOT,initialize,save,docker,createRuntime,destroyRuntime}from'../core.ts';
import{runAxi,runClaude}from'../adapters.ts';
import{runAxiV1}from'../v1/adapter.ts';
import{schedule,type TaskId,type Variant}from'../v1/settings.ts';
import{grade as rawGrade}from'../v1/grade.ts';
import{reference,taskFiles}from'../v1/tasks.ts';
import{writeTraceIndex}from'../trace.ts';
import{authorization,STUDY,IMAGE,read}from'./config.ts';
import{profile}from'./profile.ts';
import{gates}from'./gates.ts';
import{executeCandidate,verifyExecution,exclusive}from'./execution.ts';
import{gradeInWorker}from'./grading.ts';
import{recoveryDecision,nextAfterGrade,regradeAll}from'./recovery.ts';
const mode=process.argv[2];if(!['--check','--live','--resume'].includes(mode??''))throw Error('需要 --check/--live/--resume');
const a=authorization(),p=profile(),statePath=join(STUDY,'state.json');let state:any;
if(mode==='--resume'){
 state=read(statePath);if(state.authorization.start!==a.start||state.authorization.deadline!==a.deadline||state.authorization.maxStarts!==a.maxStarts)throw Error('不能重置正式预算或截止');const approval=read(join(STUDY,'grader-repair.json')),cal=read(join(STUDY,'calibration-latest.json')),fault=read(join(STUDY,'recovery-checks-latest.json'));
 const evidenceComplete=state.executions.every((x:any)=>!!verifyExecution(x.runDirectory,state.executionProfileHash));
 const decision=recoveryDecision({used:state.gradeRecoveryUsed,executionMatches:state.executionProfileHash===p.executionProfileHash,oracleMatches:state.oracleHash===p.oracleHash,evidenceComplete,semanticsReviewed:approval.reviewedBy==='current-assistant'&&approval.semanticsUnchanged===true&&approval.previousRevision===state.graderRevision&&approval.newRevision===p.graderRevision&&typeof approval.evidence==='string',calibrationPassed:cal.complete&&cal.image===IMAGE&&cal.sourceHash===p.sourceHash&&cal.results.length===14&&cal.results.every((r:any)=>r.passed),faultChecksPassed:fault.complete&&fault.sourceHash===p.sourceHash&&fault.results.length===6&&fault.results.every((r:any)=>r.passed),remainingMs:a.deadlineMs-Date.now(),completed:state.executions.length});
 if(state.phase!=='grade_repair_required'||!decision.allowed||p.graderRevision===state.graderRevision||p.graderEpoch!==1)throw Error('不允许恢复:'+decision.reason);
 state.gradeRecoveryUsed=true;state.previousGraderRevision=state.graderRevision;state.graderRevision=p.graderRevision;state.phase='regrading';save(statePath,state);
 try{await regradeAll(state.executions,(x:any)=>gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,a.workDeadline),(x:any,score:any)=>{state.scores[x.id]=score;save(statePath,state)})}catch(error){state.phase='stopped';state.stopReason='grade_recovery_failed';save(statePath,state);throw error}

}else{
 const ready=gates();if(mode==='--check'){console.log(JSON.stringify({ready:true,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,deadline:a.deadline}));process.exit(0)}
 exclusive(join(STUDY,'formal.claim'),{time:new Date().toISOString(),deadline:a.deadline,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision});
 state={phase:'running',authorization:a,executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash,graderRevision:p.graderRevision,sourceHash:p.sourceHash,attempts:[],executions:[],scores:{},selection:[],retryGroups:[],upstreamRecoveryUsed:false,gradeRecoveryUsed:false,probeStarts:3,batches:[],gates:ready.reports};
}
const persist=()=>save(statePath,state);state.phase='running';persist();
const batch=await initialize();state.batches.push({id:batch.id,directory:batch.directory});persist();
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'v1-stable',traceVersion:2,batch:batch.id,image:IMAGE,authorization:a,...p});
async function one(task:TaskId,variant:Variant,repeat:number,retry:boolean){
 const id=`formal-${task}-r${repeat}-${variant}${retry?'-retry1':''}`;let x=state.executions.find((r:any)=>r.id===id);
 if(!x){
  if(state.attempts.some((r:any)=>r.id===id))throw Error('已有未完成执行，不自动重复启动');
  if(state.attempts.length>=21||Date.now()+45*60000>a.workDeadline)throw Error('样本预算或截止不足');
  const now=profile();if(now.executionProfileHash!==state.executionProfileHash||now.oracleHash!==state.oracleHash||now.graderRevision!==state.graderRevision)throw Error('冻结后源码或输入改变');
  state.attempts.push({id,task,variant,repeat,retry,time:new Date().toISOString()});persist();
  x=await executeCandidate(batch,task,variant,repeat,id,state.executionProfileHash,{deadline:a.workDeadline});state.executions.push(x);persist();
  const prior=state.executions.find((r:any)=>r.task===task&&r.id!==id);if(prior&&prior.initialCommit!==x.initialCommit)throw Error('同题Git初态不同');
  if(['unclassified_failure','evaluation_invalid'].includes(x.classification))throw Error('执行设施或协议异常');
 }
 if(!state.scores[id]){
  const score=await gradeInWorker(x.runDirectory,STUDY,state.graderRevision,state.executionProfileHash,a.workDeadline);state.scores[id]=score;persist();
  console.log(JSON.stringify({id,execution:x.executionStatus,grade:score.gradeStatus,code:score.codePassed,regression:score.regressionPassed,requests:x.forwardedGenerationRequests}));
  const next=nextAfterGrade(score.gradeStatus,state.gradeRecoveryUsed);if(next!=='continue'){state.phase=next==='stop'?'stopped':next;state.stopReason='grade_indeterminate';persist();throw Error(state.phase)}
 }
 return x;
}
async function health(group:number){
 for(const variant of ['old','new','claude']as const){if(state.probeStarts>=6)throw Error('探针额度不足');const id=`recovery-health-${variant}`,r=await createRuntime(batch,id,{maxRounds:1,maxTotal:12});state.probeStarts++;persist();
  try{const x=await(variant==='old'?runAxi:variant==='new'?runAxiV1:runClaude)(batch,r,['只回复 V1-READY，不调用工具。'],{maxMs:120000,...(variant==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{})});save(join(r.directory,'health.json'),{passed:x.status==='completed'&&x.turns.join('\n').includes('V1-READY')});if(!read(join(r.directory,'health.json')).passed)throw Error('上游恢复探针失败');}
  finally{await destroyRuntime(batch,r)}if(read(join(r.directory,'trace-manifest.json')).status!=='complete_observable')throw Error('探针Trace缺失');
 }state.retryGroups.push(group);persist();
}
try{
 for(let i=0;i<schedule.length;i++){
  if(state.selection.some((s:any)=>s.group===i+1))continue;
  if(Date.now()+135*60000>a.workDeadline)throw Error('完整三方窗口不足');const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3)throw Error('归档磁盘余量不足');
  const spec=schedule[i]!;
  // 每组一次离线健康检查；失败不重抽，且不调用模型。
  const healthPath=join(STUDY,`group-health-${i+1}`);
  if(!existsSync(join(healthPath,'grade.json'))){const g=await rawGrade(IMAGE,spec.task,`health-${Date.now()}-${i}`,taskFiles(spec.task),reference(spec.task),healthPath,{regression:false,deadline:a.workDeadline});if(!g.codePassed)throw Error('组前离线参考健康检查失败')}
  const originals=[];for(const v of spec.variants)originals.push(await one(spec.task,v,spec.repeat,false));
  let adopted=originals,retry=state.retryGroups.includes(i+1);
  if(originals.some(r=>r.classification==='environment_indeterminate')){
   if(!retry){if(state.upstreamRecoveryUsed)throw Error('上游整组恢复额度已用');if(Date.now()+141*60000>a.workDeadline)throw Error('整组恢复窗口不足');state.upstreamRecoveryUsed=true;persist();await health(i+1);retry=true}
   adopted=[];for(const v of spec.variants)adopted.push(await one(spec.task,v,spec.repeat,true));
   if(adopted.some(r=>r.classification==='environment_indeterminate'))throw Error('上游整组恢复仍不可判定');
  }
  state.selection.push({group:i+1,task:spec.task,repeat:spec.repeat,ids:adopted.map(r=>r.id),retry,...(retry?{supersededIds:originals.map(r=>r.id)}:{})});persist();
 }state.phase='completed';delete state.stopReason;
}catch(error){if(state.phase==='running'){state.phase='stopped';state.stopReason=String(error)}save(join(STUDY,`run-error-${Date.now()}.json`),{error:String(error),phase:state.phase,time:new Date().toISOString()});}
finally{state.lastUpdated=new Date().toISOString();persist();save(join(batch.directory,'results.json'),state.executions.filter((x:any)=>x.runDirectory.startsWith(batch.directory+'/')));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,starts:state.attempts.length,adoptedGroups:state.selection.length,stopReason:state.stopReason}));
