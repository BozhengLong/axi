import {join} from 'node:path';
import {existsSync,statfsSync} from 'node:fs';
import {initialize,save,docker} from '../core.ts';
import {executeCandidate,exclusive,verifyExecution} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {authorization,claimStart,STUDY,read,pairs,developmentSchedule} from './config.ts';
import {profile,revisionFor} from './profile.ts';
import {capture} from './provenance.ts';
import {gradeInWorker} from './grading.ts';
import {GradingIndeterminate} from './status.ts';
import {withResources} from './resources.ts';
import {freshState,nextSlot,setSlot,openIssue,resolvedSample} from './modules.ts';
import {versions} from './versions.ts';
import {modelEvidence} from './model-evidence.ts';
if(!['--pair','--resume-pair'].includes(process.argv[2]??''))throw Error('需要--pair或--resume-pair及固定配对ID');
const resuming=process.argv[2]==='--resume-pair',pair=pairs.find(x=>x.id===process.argv[3]);if(!pair)throw Error('无效配对');
const a=authorization(),p=profile(),statePath=join(STUDY,'attribution.json');
for(const name of ['preflight-latest.json','offline-gates.json']){const g=read(join(STUDY,name));if(!g.complete||g.executionProfileHash!==p.executionProfileHash||g.image!==p.execution.image||name==='offline-gates.json'&&g.sourceHash!==p.sourceHash)throw Error('当前准入不完整:'+name)}
const state=existsSync(statePath)?read(statePath):{...freshState(developmentSchedule,pairs),phase:'running',executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash,graderRevision:p.graderRevision,moduleGraderRevisions:p.moduleGraderRevisions,rows:[],batches:[],gradeRecoveryUsed:false};
if(state.global!=='running'||state.executionProfileHash!==p.executionProfileHash||state.oracleHash!==p.oracleHash||existsSync(join(STUDY,'stop.json')))throw Error('冻结或全局停止状态不符');
if(state.modules[pair.module].status!=='active')throw Error('模块已暂停或关闭');
for(const prior of pairs.slice(0,pairs.indexOf(pair))){
 if(state.modules[prior.module].status==='closed')continue;
 const review=read(join(STUDY,'manual-review',prior.id+'.json')),rows=state.rows.filter((r:any)=>r.pair===prior.id);
 if(review.reviewComplete!==true&&review.complete!==true||review.hardBlocker!==false||rows.length!==2||rows.some((r:any)=>r.score?.gradeStatus!=='complete'&&!resolvedSample(state,r.execution.id)||verifyExecution(r.execution.runDirectory,p.executionProfileHash).artifactHash!==review.artifacts[r.execution.id]))throw Error('前一配对缺少可信判定或已定位缺失的记录');
 for(const row of rows){const slot=state.slots.find((x:any)=>x.id===row.execution.id);if(slot.status==='manual_review_required')setSlot(state,row.execution.id,'judged',row.execution.artifactHash)}
}
const first=nextSlot(state);if(!first||first.pair!==pair.id)throw Error('必须继续最早可运行配对');
const reserve=state.repair.used?0:120*60000;
if(Date.now()+(state.rows.length===0?8:1)*a.pairSeconds*1000+reserve>a.workDeadline)throw Error('剩余完整配对与修复窗口不足');
if(resuming){if(!existsSync(join(STUDY,pair.id+'.claim')))throw Error('没有可恢复配对');}
else exclusive(join(STUDY,pair.id+'.claim'),{started:new Date().toISOString(),profile:p.executionProfileHash});
const batch=await initialize();capture(batch.directory);state.batches.push({id:batch.id,directory:batch.directory});
save(join(batch.directory,'manifest.json'),{suite:'v1-attribution-followup-live',pair:pair.id,module:pair.module,batch:batch.id,image:batch.image,traceVersion:2,...p});
const persist=()=>{state.updatedAt=new Date().toISOString();save(statePath,state)};persist();
let activeId:string|undefined;
try{
 for(const product of pair.products){
  const id=pair.id+'-'+product,slot=state.slots.find((x:any)=>x.id===id);
  if(resuming&&['manual_review_required','judged','indeterminate'].includes(slot.status))continue;
  if(slot.status!=='unstarted')throw Error('已启动槽不能重跑，先处理原封存');
  const current=profile();if(current.executionProfileHash!==p.executionProfileHash||revisionFor(current,pair.task)!==revisionFor(p,pair.task))throw Error('运行身份改变');
  const disk=statfsSync(STUDY);if(disk.bavail*disk.bsize<4*1024**3)throw Error('证据磁盘余量不足');
  const version=versions.find(v=>v.product===product)!;activeId=id;
  const x=await withResources('live:'+id,async()=>{
   claimStart(id,'task',{task:pair.task,module:pair.module,product,axiEntry:version.axiEntry,batch:batch.id,profile:p.executionProfileHash});Object.assign(state,read(statePath));
   return executeCandidate(batch,pair.task,version.variant,pair.repeat,id,p.executionProfileHash,{axiEntry:version.axiEntry,...(product==='axi'?{reviewMode:'auto' as const,observeReview:true}:{}),deadline:a.workDeadline});
  });
  setSlot(state,id,'sealed',x.artifactHash);const row:any={execution:x,product,pair:pair.id,module:pair.module,assisted:pair.task==='V1-Q'};state.rows.push(row);persist();
  row.modelEvidence=modelEvidence(x.runDirectory,x.id);persist();
  const prior=state.rows.find((r:any)=>r.pair===pair.id&&r.execution.id!==id);if(prior&&prior.execution.initialCommit!==x.initialCommit)throw Error('配对初态不同');
  if(!['completed','candidate_unfinished'].includes(x.classification)){
   openIssue(state,{id:'execution-'+id,scope:x.classification==='environment_indeterminate'?'sample':'common',kind:x.classification==='environment_indeterminate'?'sample':'safety',sample:id,reason:x.classification,openedAt:Date.now()});state.phase='incident_required';persist();break;
  }
  setSlot(state,id,'grading',x.artifactHash);state.phase='grading';persist();const deadline=Math.min(Date.now()+900000,a.workDeadline),revision=revisionFor(p,pair.task);
  row.score=await gradeInWorker(x.runDirectory,STUDY,revision,p.executionProfileHash,deadline);persist();if(row.score.gradeStatus!=='complete')throw new GradingIndeterminate(row.score.origin,'final');
  if(existsSync(join(x.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(x.runDirectory,STUDY,revision,p.executionProfileHash,deadline,'checkpoint');persist();if(row.checkpointScore.gradeStatus!=='complete')throw new GradingIndeterminate(row.checkpointScore.origin,'checkpoint')}
  if(row.score.failureChecks.some((c:string)=>['PROTECT','GIT'].includes(c)))throw Error('保护要求失败');
  setSlot(state,id,'manual_review_required',x.artifactHash);state.phase='running';persist();
  console.log(JSON.stringify({id,status:x.executionStatus,code:row.score.codePassed,regression:row.score.regressionPassed,requests:x.forwardedGenerationRequests,failures:row.score.failureChecks}));activeId=undefined;
 }
 if(state.global==='running')state.phase='manual_review_required';
}catch(error){
 const grading=error instanceof GradingIndeterminate;
 // 未知评分原因先按共用范围暂停；不能因为正在跑E就武断认定只影响E。
 openIssue(state,{id:'failure-'+Date.now(),scope:'common',kind:grading?'measurement':'safety',sample:activeId,reason:String(error),openedAt:Date.now(),uncertainScope:grading});
 state.phase=grading&&!state.repair.used?'grade_repair_required':'incident_required';state.reason=String(error);
}finally{persist();save(join(batch.directory,'results.json'),state.rows.filter((r:any)=>r.execution.runDirectory.startsWith(batch.directory+'/')).map((r:any)=>r.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,global:state.global,taskStarts:state.rows.length,reason:state.reason}));
