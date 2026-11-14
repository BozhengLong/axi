import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {ROOT,initialize,save,docker,type Snapshot} from '../core.ts';
import {executeCandidate} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {taskFiles} from '../v1/tasks.ts';
import {reference} from './tasks.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
import {FRESH,IMAGE,tasks} from './settings.ts';
if(process.argv[2]!=='--mock')throw Error('需要 --mock');
const p=profile(),batch=await initialize(),results:any[]=[];let complete=false;
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'fresh-pipeline-mock',traceVersion:2,batch:batch.id,image:IMAGE,...p});
const persist=()=>save(join(FRESH,'pipeline-latest.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,batch:batch.id,directory:batch.directory,results});
function command(changes:Snapshot,cache:boolean){
 const code='import{writeFileSync,mkdirSync,unlinkSync,readFileSync}from"node:fs";import{dirname}from"node:path";let blocked=false;try{writeFileSync("node_modules/.axi-readonly-probe","x");unlinkSync("node_modules/.axi-readonly-probe")}catch(e){blocked=["EROFS","EACCES"].includes(e.code)}if(!blocked)throw Error("dependency write unexpectedly allowed");'+(cache?'writeFileSync("node_modules/.cache/axi-probe","temporary");if(readFileSync("node_modules/.cache/axi-probe","utf8")!=="temporary")throw Error("cache write failed");unlinkSync("node_modules/.cache/axi-probe");':'')+'const f=JSON.parse(Buffer.from("'+Buffer.from(JSON.stringify(changes)).toString('base64')+'","base64").toString());for(const[p,e]of Object.entries(f)){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,Buffer.from(e.data,"base64"),{mode:e.mode})}console.log("reference-written; dependencies-readonly; cache-isolated");';
 return "bun -e '"+code+"'";
}
try{
 for(const task of tasks)for(const variant of ['old','new','claude']as const){
  const seed=taskFiles(task),ref=reference(task),changes=Object.fromEntries(Object.entries(ref).filter(([k,v])=>JSON.stringify(seed[k])!==JSON.stringify(v)));
  const tool=(id:string,files:Snapshot)=>({content:[{type:'tool_use',id,name:variant==='claude'?'Bash':'bash',input:{command:command(files,task==='V1-D')}}],stopReason:'tool_use'});
  const end=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'});
  const draft=Object.fromEntries(Object.entries(changes).filter(([k])=>k==='readme.md'||k.startsWith('eval-tests/')));
  const mock=variant==='new'?[tool('initial-draft',draft),end('模拟待复核初稿。'),tool('review-write',changes),end('模拟最终参考交付，不计模型能力。')]:[tool('reference-write',changes),end('模拟参考交付，不计模型能力。')];
  const id=`fresh-pipeline-${task}-${variant}`,x=await executeCandidate(batch,task,variant,0,id,p.executionProfileHash,{mock,maxMs:120000,...(variant==='new'?{reviewMode:'auto',observeReview:true}:{}),deadline:p.authorization.workDeadline});
  const deadline=Math.min(Date.now()+15*60000,p.authorization.workDeadline),score=await gradeInWorker(x.runDirectory,batch.directory,p.graderRevision,p.executionProfileHash,deadline);
  const checkpoint=variant==='new'?await gradeInWorker(x.runDirectory,batch.directory,p.graderRevision,p.executionProfileHash,deadline,'checkpoint'):undefined;
  const passed=x.executionStatus==='completed'&&score.gradeStatus==='complete'&&score.codePassed&&score.regressionPassed&&(!checkpoint||(checkpoint.gradeStatus==='complete'&&!checkpoint.codePassed));
  results.push({id,task,variant,passed,execution:x,score,checkpoint});persist();console.log(JSON.stringify({id,passed}));if(!passed)throw Error('三方模拟或封存评分不通过');
 }
 complete=true;
}finally{persist();save(join(batch.directory,'results.json'),results.map(r=>r.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
