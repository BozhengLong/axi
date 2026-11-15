import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {ROOT,initialize,save,docker,type Snapshot} from '../core.ts';
import {executeCandidate} from '../stable/execution.ts';
import {writeTraceIndex} from '../trace.ts';
import {taskFiles} from '../v1/tasks.ts';
import {reference} from './tasks.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
import {STUDY,IMAGE,allTasks as tasks} from './config.ts';
import {withResources} from './resources.ts';
import {taskManifest} from '../v1/tasks.ts';
import {versions} from './versions.ts';
if(process.argv[2]!=='--mock')throw Error('需要 --mock');
const p=profile(),batch=await initialize(),results:any[]=[];let complete=false;
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'trust-pipeline-mock',mockOnly:true,traceVersion:2,batch:batch.id,image:IMAGE,...p});
const persist=()=>save(join(STUDY,'pipeline-latest.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,batch:batch.id,directory:batch.directory,results});
function command(changes:Snapshot,cache:boolean,task:typeof tasks[number],final:boolean){
 const code='import{writeFileSync,mkdirSync,unlinkSync,readFileSync}from"node:fs";import{dirname}from"node:path";let blocked=false;try{writeFileSync("node_modules/.axi-readonly-probe","x");unlinkSync("node_modules/.axi-readonly-probe")}catch(e){blocked=["EROFS","EACCES"].includes(e.code)}if(!blocked)throw Error("dependency write unexpectedly allowed");'+(cache?'writeFileSync("node_modules/.cache/axi-probe","temporary");if(readFileSync("node_modules/.cache/axi-probe","utf8")!=="temporary")throw Error("cache write failed");unlinkSync("node_modules/.cache/axi-probe");':'')+'const f=JSON.parse(Buffer.from("'+Buffer.from(JSON.stringify(changes)).toString('base64')+'","base64").toString());for(const[p,e]of Object.entries(f)){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,Buffer.from(e.data,"base64"),{mode:e.mode})}console.log("reference-written; dependencies-readonly; cache-isolated");';
 const checks=taskManifest(task).commands.map((x:any)=>x[1]);if(final)checks.push('node --test --test-reporter=tap eval-tests/reference.test.mjs');
 const runner='const commands='+JSON.stringify(checks)+';const rows=[];for(const command of commands){const r=Bun.spawnSync(["bash","-lc",command],{stdout:"pipe",stderr:"pipe"});process.stdout.write(r.stdout);process.stderr.write(r.stderr);rows.push({command,exitCode:r.exitCode});if(r.exitCode)process.exit(r.exitCode)};Bun.write("eval-tests/pipeline-evidence.json",JSON.stringify(rows));';
 return "bun -e '"+code+"' && bun -e '"+runner.replaceAll("'","'\"'\"'")+"'";
}
try{
 for(const task of tasks)for(const version of versions){
  const {variant,product,axiEntry}=version;
  const seed=taskFiles(task),ref=reference(task),changes=Object.fromEntries(Object.entries(ref).filter(([k,v])=>JSON.stringify(seed[k])!==JSON.stringify(v)));
  const tool=(id:string,files:Snapshot)=>({content:[{type:'tool_use',id,name:variant==='claude'?'Bash':'bash',input:{command:command(files,true,task,id!=='initial-draft')}}],stopReason:'tool_use'});
  const end=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'});
  const draft=Object.fromEntries(Object.entries(changes).filter(([k])=>k==='readme.md'||k.startsWith('eval-tests/')));
  const mock=variant==='new'?[tool('initial-draft',draft),end('模拟待复核初稿。'),tool('review-write',changes),end('模拟最终参考交付，不计模型能力。')]:[tool('reference-write',changes),end('模拟参考交付，不计模型能力。')];
  const id=`attribution-pipeline-${task}-${product}`,x=await withResources('mock:'+id,()=>executeCandidate(batch,task,variant,0,id,p.executionProfileHash,{mock,maxMs:180000,axiEntry,...(variant==='new'?{reviewMode:'auto',observeReview:true}:{}),deadline:p.authorization.workDeadline}));
  const deadline=Math.min(Date.now()+15*60000,p.authorization.workDeadline),score=await gradeInWorker(x.runDirectory,batch.directory,p.graderRevision,p.executionProfileHash,deadline,'final',true);
  const checkpoint=variant==='new'?await gradeInWorker(x.runDirectory,batch.directory,p.graderRevision,p.executionProfileHash,deadline,'checkpoint',true):undefined;
  const finalFiles=JSON.parse(readFileSync(join(x.runDirectory,'final-files.json'),'utf8'));const evidence=JSON.parse(Buffer.from(finalFiles['eval-tests/pipeline-evidence.json'].data,'base64').toString());
  const passed=evidence.length===(task!=='V1-D'?4:3)&&evidence.every((e:any)=>e.exitCode===0)&&x.executionStatus==='completed'&&score.gradeStatus==='complete'&&score.codePassed&&score.regressionPassed&&(!checkpoint||(checkpoint.gradeStatus==='complete'&&!checkpoint.codePassed));
  results.push({id,task,variant,product,passed,evidence,execution:x,score,checkpoint});persist();console.log(JSON.stringify({id,passed}));if(!passed)throw Error('三方模拟或封存评分不通过');
 }
 complete=true;
}finally{persist();save(join(batch.directory,'results.json'),results.map(r=>r.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
