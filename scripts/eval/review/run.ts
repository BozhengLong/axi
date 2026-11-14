import {join,dirname} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statfsSync} from 'node:fs';
import {ROOT,initialize,save,docker} from '../core.ts';
import {executeCandidate,exclusive} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {authorization,claimStart,STUDY,read,type StartKind} from './config.ts';
import {profile} from './profile.ts';
import {gradeInWorker,GradeInfrastructureError} from './grading.ts';
import {recoverGrades} from './recovery.ts';
import type {TaskId} from '../v1/settings.ts';
const mode=process.argv[2];if(!['--development','--c7','--resume-development','--resume-c7'].includes(mode??''))throw Error('需要明确阶段及恢复模式');
const resume=mode!.startsWith('--resume'),a=authorization(),p=profile(),kind=mode!.endsWith('development')?'development':'c7';
const recovered=existsSync(join(STUDY,'grade-recovery.claim'))&&read(join(STUDY,'grade-recovery.claim')).next===p.graderRevision;
for(const name of ['preflight-latest.json','offline-gates.json']){const g=read(join(STUDY,name));if(!g.complete||(!resume&&!recovered&&g.sourceHash!==p.sourceHash)||g.image!==p.execution.image||(name==='offline-gates.json'&&g.executionProfileHash!==p.executionProfileHash))throw Error('门槛缺失或版本不符:'+name)}
if(kind==='c7'){
 const gate=read(join(STUDY,'development-review.json')),frozen=read(join(STUDY,'release-candidate-freeze.json'));
 if(gate.status!=='passed'||gate.autoFullDelivery!==2||gate.profile!==p.executionProfileHash||frozen.productHash!==p.execution.productHash||frozen.reviewMode!=='auto')throw Error('开发复核或候选冻结不符');
}
let state:any;
if(resume)state=await recoverGrades(kind);else{exclusive(join(STUDY,kind+'.claim'),{started:new Date().toISOString(),profile:p.executionProfileHash});state={phase:'running',kind,executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash,graderRevision:p.graderRevision,rows:[],gradeRecoveryUsed:false,batches:[]}}
const batch=await initialize(),rows:any[]=state.rows;state.batches??=[];state.batches.push({id:batch.id,directory:batch.directory});state.batch=batch.id;state.directory=batch.directory;state.phase='running';
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'v1-review-'+kind,batch:batch.id,image:batch.image,traceVersion:2,...p});
const persist=()=>save(join(STUDY,kind+'.json'),state);persist();
const schedule:(readonly[TaskId,'off'|'auto'])[]=kind==='development'?[['V1-A','off'],['V1-A','auto'],['V1-B','auto'],['V1-B','off']]:[['C7-L','auto'],['C7-O','auto']];
try{
 for(const [task,reviewMode]of schedule){
  const now=profile();if(now.executionProfileHash!==p.executionProfileHash||now.oracleHash!==p.oracleHash||now.graderRevision!==p.graderRevision)throw Error('源码或评分冻结发生改变');
  const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3)throw Error('归档磁盘余量不足');
  const id=kind+'-'+task+'-'+reviewMode;if(rows.some(r=>r.execution.id===id&&r.score?.gradeStatus==='complete'))continue;claimStart(id,kind as StartKind,{task,variant:'new',reviewMode,batch:batch.id,profile:p.executionProfileHash});
  const x=await executeCandidate(batch,task,'new',1,id,p.executionProfileHash,{reviewMode,observeReview:true,deadline:a.workDeadline});rows.push({execution:x,reviewMode});persist();
  const prior=rows.find(r=>r.execution.task===task&&r.execution.id!==id);if(prior&&prior.execution.initialCommit!==x.initialCommit)throw Error('同题Git初态不同');
  if(!['completed','candidate_unfinished'].includes(x.classification))throw Error('环境或协议中断，不重抽：'+x.classification);
  // 一次执行的最终产物及检查点评分共享15分钟，不为复核额外增加评分预算。
  state.phase='grading';persist();
  const gradeDeadline=Math.min(Date.now()+15*60000,a.workDeadline);
  const score=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,gradeDeadline);rows.at(-1).score=score;persist();
  if(score.gradeStatus!=='complete')throw new GradeInfrastructureError('评分不可判定');
  if(existsSync(join(x.runDirectory,'review-checkpoint.json'))){
   const checkpoint=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,gradeDeadline,'checkpoint');rows.at(-1).checkpointScore=checkpoint;persist();
   if(checkpoint.gradeStatus!=='complete')throw new GradeInfrastructureError('检查点评分不可判定');
  }
  state.phase='running';persist();
  console.log(JSON.stringify({id,status:x.executionStatus,grade:score.gradeStatus,codePassed:score.codePassed,regressionPassed:score.regressionPassed,failureChecks:score.failureChecks,requests:x.forwardedGenerationRequests,checkpointCodePassed:rows.at(-1).checkpointScore?.codePassed}));
 }
 state.phase='manual_review_required';
}catch(error){state.phase=state.phase==='grading'&&error instanceof GradeInfrastructureError&&!existsSync(join(STUDY,'grade-recovery.claim'))?'grade_repair_required':'stopped';state.reason=String(error)}
finally{state.finished=new Date().toISOString();persist();save(join(batch.directory,'results.json'),rows.filter(x=>x.execution.runDirectory.startsWith(batch.directory+'/')).map(x=>x.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,starts:rows.length,reason:state.reason}));
