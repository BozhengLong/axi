import {join} from 'node:path';
import {existsSync,statfsSync} from 'node:fs';
import {initialize,save,docker} from '../core.ts';
import {executeCandidate,exclusive} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {authorization,claimStart,requestStop,STUDY,read,developmentSchedule} from './config.ts';
import {profile} from './profile.ts';
import {capture} from './provenance.ts';
import {gradeInWorker} from './grading.ts';
import {GradingIndeterminate} from './status.ts';
import {withResources} from './resources.ts';
import {afterDrain} from './control.ts';
import {versions} from './versions.ts';
import {recoverDevelopment} from './recovery.ts';
const mode=process.argv[2];if(!['--development','--resume-development'].includes(mode??''))throw Error('需要明确development阶段');
const resume=mode==='--resume-development',a=authorization(),p=profile();
for(const name of ['preflight-latest.json','offline-gates.json']){const g=read(join(STUDY,name));if(!g.complete||(!resume&&g.sourceHash!==p.sourceHash)||g.image!==p.execution.image||g.executionProfileHash!==p.executionProfileHash)throw Error('门槛缺失或版本不符:'+name)}
let state:any;
if(resume)state=await recoverDevelopment();else{exclusive(join(STUDY,'development.claim'),{started:new Date().toISOString(),profile:p.executionProfileHash});state={phase:'running',executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash,graderRevision:p.graderRevision,rows:[],gradeRecoveryUsed:false,batches:[]}}
const batch=await initialize();capture(batch.directory);state.batches.push({id:batch.id,directory:batch.directory});state.phase='running';
save(join(batch.directory,'manifest.json'),{suite:'v1-reentry-development',batch:batch.id,image:batch.image,traceVersion:2,...p});
const persist=()=>save(join(STUDY,'development.json'),state);persist();
try{
 for(const {task,product}of developmentSchedule){
  const now=profile();if(now.executionProfileHash!==p.executionProfileHash||now.oracleHash!==p.oracleHash||now.graderRevision!==p.graderRevision)throw Error('源码或评分冻结变化');
  const id='development-'+task+'-'+product;if(state.rows.some((r:any)=>r.execution.id===id&&r.score?.gradeStatus==='complete'))continue;
  const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3)throw Error('归档磁盘余量不足');
  const version=versions.find(v=>v.product===product)!;
  const x=await withResources('live:'+id,async()=>{claimStart(id,'development',{task,product,axiEntry:version.axiEntry,reviewMode:'auto',batch:batch.id,profile:p.executionProfileHash});return executeCandidate(batch,task,'new',1,id,p.executionProfileHash,{axiEntry:version.axiEntry,reviewMode:'auto',observeReview:true,deadline:a.workDeadline})});
  const row:any={execution:x,product};state.rows.push(row);persist();
  const prior=state.rows.find((r:any)=>r.execution.task===task&&r.execution.id!==id);if(prior&&prior.execution.initialCommit!==x.initialCommit)throw Error('同题初态不一致');
  if(!['completed','candidate_unfinished'].includes(x.classification))throw Error('执行异常，不自动重抽:'+x.classification);
  state.phase='grading';persist();const deadline=Math.min(Date.now()+900000,a.workDeadline);
  row.score=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline);persist();
  if(row.score.gradeStatus!=='complete')throw new GradingIndeterminate(row.score.origin,'final');
  if(existsSync(join(x.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');persist();if(row.checkpointScore.gradeStatus!=='complete')throw new GradingIndeterminate(row.checkpointScore.origin,'checkpoint')}
  if(row.score.failureChecks.some((c:string)=>['PROTECT','GIT'].includes(c)))throw Error('保护要求失败，停止后续任务');
  state.phase='running';persist();console.log(JSON.stringify({id,status:x.executionStatus,code:row.score.codePassed,regression:row.score.regressionPassed,requests:x.forwardedGenerationRequests,failures:row.score.failureChecks,checkpointCode:row.checkpointScore?.codePassed}));
 }
 state.phase='manual_review_required';
}catch(error){const grader=error instanceof GradingIndeterminate;state.phase=grader&&!state.gradeRecoveryUsed?'grade_repair_required':'stopped';state.reason=String(error);requestStop(state.reason,!grader)}
finally{if(existsSync(join(STUDY,'stop.json'))){const stopped=read(join(STUDY,'stop.json'));if(stopped.state==='draining')save(join(STUDY,'stop.json'),afterDrain(stopped))}state.updatedAt=new Date().toISOString();persist();save(join(batch.directory,'results.json'),state.rows.filter((x:any)=>x.execution.runDirectory.startsWith(batch.directory+'/')).map((x:any)=>x.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,starts:state.rows.length,reason:state.reason}));
