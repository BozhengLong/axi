import {join,dirname} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {ROOT,initialize,save,docker,command} from '../core.ts';
import {executeCandidate,verifyExecution,exclusive} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {authorization,claimStart,STUDY,read} from './config.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
if(process.argv[2]!=='--pilots')throw Error('当前入口仅执行两个已知开发题，正式阶段单独冻结');
const a=authorization(),p=profile();
for(const name of ['preflight-latest.json','offline-gates.json']){const g=read(join(STUDY,name));if(!g.complete||g.sourceHash!==p.sourceHash||g.image!==p.execution.image)throw Error('门槛缺失或版本不符:'+name)}
exclusive(join(STUDY,'pilots.claim'),{started:new Date().toISOString(),profile:p.executionProfileHash});
const batch=await initialize(),rows:any[]=[],state:any={phase:'running',batch:batch.id,directory:batch.directory,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,rows};
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'v1-rc-development',traceVersion:2,...p});
const persist=()=>save(join(STUDY,'pilots.json'),state);persist();
try{
 for(const task of ['V1-A','V1-B']as const){
  if(profile().executionProfileHash!==p.executionProfileHash)throw Error('开发试跑之间源码发生改变');
  const id='pilot-'+task;claimStart(id,'pilot',{task,variant:'new',batch:batch.id,profile:p.executionProfileHash});
  const x=await executeCandidate(batch,task,'new',1,id,p.executionProfileHash,{deadline:a.workDeadline});rows.push({execution:x});persist();
  if(!['completed','candidate_unfinished'].includes(x.classification))throw Error('开发运行环境或协议中断，不补跑：'+x.classification);
  const score=await gradeInWorker(x.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,a.workDeadline);rows.at(-1).score=score;persist();
  console.log(JSON.stringify({id,status:x.executionStatus,grade:score.gradeStatus,codePassed:score.codePassed,regressionPassed:score.regressionPassed,failureChecks:score.failureChecks,requests:x.forwardedGenerationRequests}));
  if(score.gradeStatus!=='complete')throw Error('评分不可判定');
 }
 state.phase='manual_review_required';
}catch(error){state.phase='stopped';state.reason=String(error)}
finally{state.finished=new Date().toISOString();persist();save(join(batch.directory,'results.json'),rows.map(x=>x.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
console.log(JSON.stringify({phase:state.phase,starts:rows.length,reason:state.reason}));
