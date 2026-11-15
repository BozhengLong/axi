import {join} from 'node:path';
import {existsSync,statfsSync} from 'node:fs';
import {initialize,save,docker} from '../core.ts';
import {executeCandidate,exclusive,verifyExecution} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {authorization,claimStart,requestStop,STUDY,read,pairs} from './config.ts';
import {profile} from './profile.ts';
import {capture} from './provenance.ts';
import {gradeInWorker} from './grading.ts';
import {GradingIndeterminate} from './status.ts';
import {withResources} from './resources.ts';
import {afterDrain} from './control.ts';
import {versions} from './versions.ts';
import {modelEvidence} from './model-evidence.ts';
if(!['--pair','--resume-pair'].includes(process.argv[2]??''))throw Error('需要明确 --pair或--resume-pair P1..Q4');
const resume=process.argv[2]==='--resume-pair';
const index=pairs.findIndex(p=>p.id===process.argv[3]);if(index<0)throw Error('无效配对');const pair=pairs[index]!,a=authorization(),p=profile();
for(const name of ['preflight-latest.json','offline-gates.json']){const g=read(join(STUDY,name));if(!g.complete||(name==='offline-gates.json'||p.graderEpoch===0)&&g.sourceHash!==p.sourceHash||g.image!==p.execution.image||g.executionProfileHash!==p.executionProfileHash)throw Error('门槛缺失或版本不符:'+name)}
const statePath=join(STUDY,'attribution.json');const state=existsSync(statePath)?read(statePath):{phase:'running',executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash,graderRevision:p.graderRevision,rows:[],gradeRecoveryUsed:false,batches:[]};
if((resume?state.rows.length!==index*2+1||!state.gradeRecoveryUsed||!existsSync(join(STUDY,pair.id+'.claim')):state.rows.length!==index*2)||state.executionProfileHash!==p.executionProfileHash||state.graderRevision!==p.graderRevision||existsSync(join(STUDY,'stop.json')))throw Error('配对顺序、冻结或停止状态不符');
for(const prior of pairs.slice(0,index)){
 const review=read(join(STUDY,'manual-review',prior.id+'.json')),rows=state.rows.filter((r:any)=>r.pair===prior.id);
 if(review.complete!==true||review.hardBlocker!==false||rows.length!==2||rows.some((r:any)=>verifyExecution(r.execution.runDirectory,p.executionProfileHash).artifactHash!==review.artifacts[r.execution.id]||r.score?.gradeStatus!=='complete'))throw Error('上一对缺少产物绑定的人工判定');
}
if(Date.now()+(index===0&&!resume?8:1)*a.pairSeconds*1000>a.workDeadline)throw Error('剩余时间不足固定配对窗口');
if(!resume)exclusive(join(STUDY,pair.id+'.claim'),{started:new Date().toISOString(),profile:p.executionProfileHash});
const batch=await initialize();capture(batch.directory);state.batches.push({id:batch.id,directory:batch.directory});
save(join(batch.directory,'manifest.json'),{suite:'v1-attribution-live',pair:pair.id,batch:batch.id,image:batch.image,traceVersion:2,...p});
const persist=()=>save(statePath,state);persist();
try{
 for(const product of pair.products){
  if(resume&&state.rows.some((r:any)=>r.execution.id===pair.id+'-'+product&&r.score?.gradeStatus==='complete'))continue;
  const now=profile();if(now.executionProfileHash!==p.executionProfileHash||now.oracleHash!==p.oracleHash||now.graderRevision!==p.graderRevision)throw Error('源码或评分冻结变化');
  const id=pair.id+'-'+product,disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3)throw Error('归档磁盘余量不足');
  const version=versions.find(v=>v.product===product)!;
  const x=await withResources('live:'+id,async()=>{claimStart(id,'task',{task:pair.task,product,axiEntry:version.axiEntry,batch:batch.id,profile:p.executionProfileHash});return executeCandidate(batch,pair.task,version.variant,pair.repeat,id,p.executionProfileHash,{axiEntry:version.axiEntry,...(product==='axi'?{reviewMode:'auto' as const,observeReview:true}:{}),deadline:a.workDeadline})});
  const row:any={execution:x,product,pair:pair.id,assisted:pair.task==='V1-Q'};state.rows.push(row);persist();
  row.modelEvidence=modelEvidence(x.runDirectory,x.id);persist();
  const prior=state.rows.find((r:any)=>r.pair===pair.id&&r.execution.id!==id);if(prior&&prior.execution.initialCommit!==x.initialCommit)throw Error('同题初态不一致');
  if(!['completed','candidate_unfinished'].includes(x.classification))throw Error('执行异常，不自动重抽:'+x.classification);
  state.phase='grading';persist();const deadline=Math.min(Date.now()+900000,a.workDeadline);
  row.score=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline);persist();if(row.score.gradeStatus!=='complete')throw new GradingIndeterminate(row.score.origin,'final');
  if(existsSync(join(x.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');persist();if(row.checkpointScore.gradeStatus!=='complete')throw new GradingIndeterminate(row.checkpointScore.origin,'checkpoint')}
  if(row.score.failureChecks.some((c:string)=>['PROTECT','GIT'].includes(c)))throw Error('保护要求失败，停止后续任务');
  state.phase='running';persist();console.log(JSON.stringify({id,status:x.executionStatus,code:row.score.codePassed,regression:row.score.regressionPassed,requests:x.forwardedGenerationRequests,failures:row.score.failureChecks}));
 }
 state.phase='manual_review_required';
}catch(error){const grader=error instanceof GradingIndeterminate;state.phase=grader&&!state.gradeRecoveryUsed?'grade_repair_required':'stopped';state.reason=String(error);requestStop(state.reason,!grader)}
finally{if(existsSync(join(STUDY,'stop.json'))){const stopped=read(join(STUDY,'stop.json'));if(stopped.state==='draining')save(join(STUDY,'stop.json'),afterDrain(stopped))}state.updatedAt=new Date().toISOString();persist();save(join(batch.directory,'results.json'),state.rows.filter((x:any)=>x.execution.runDirectory.startsWith(batch.directory+'/')).map((x:any)=>x.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,starts:state.rows.length,reason:state.reason}));
