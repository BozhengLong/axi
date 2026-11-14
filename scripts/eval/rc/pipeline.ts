import{join,dirname}from'node:path';
import{mkdirSync,writeFileSync,readFileSync}from'node:fs';
import{ROOT,initialize,docker,save}from'../core.ts';
import{taskFiles,reference}from'../v1/tasks.ts';
import{reference as c7Reference}from'../c7/tasks.ts';
import{type TaskId,type Variant}from'../v1/settings.ts';
import{writeTraceIndex}from'../trace.ts';
import{authorization,STUDY,IMAGE}from'./config.ts';
import{profile}from'./profile.ts';
import{executeCandidate}from'../stable/execution.ts';
import{gradeInWorker}from'./grading.ts';
if(process.argv[2]!=='--mock')throw Error('需要 --mock');
const a=authorization(),p=profile(),batch=await initialize(),results:any[]=[];let complete=false;
for(const path of Object.keys(p.hashes)){const dest=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'stable-pipeline-mock',traceVersion:2,batch:batch.id,image:IMAGE,...p});
const persist=()=>{const r={complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,batch:batch.id,directory:batch.directory,results};save(join(batch.directory,'pipeline.json'),r);save(join(STUDY,'pipeline-latest.json'),r)};
persist();
try{
 for(let pass=1;pass<=1;pass++)for(const task of ['V1-A','V1-B','C7-L','C7-O']as TaskId[])for(const variant of (task.startsWith('V1-')?['old','new','claude']:['new'])as Variant[]){
  const seed=taskFiles(task),ref=task.startsWith('C7')?c7Reference(task as 'C7-L'|'C7-O',seed):reference(task),changes=Object.fromEntries(Object.entries(ref).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(seed[k])));
  const script='import{writeFileSync,mkdirSync}from"node:fs";import{dirname}from"node:path";const f=JSON.parse(Buffer.from("'+Buffer.from(JSON.stringify(changes)).toString('base64')+'","base64").toString());for(const[p,e]of Object.entries(f)){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,Buffer.from(e.data,"base64"),{mode:e.mode})}';
  const mock=[{content:[{type:'tool_use',id:'mock-reference',name:variant==='claude'?'Bash':'bash',input:{command:"bun -e '"+script+"'"}}],stopReason:'tool_use'},{content:[{type:'text',text:'模拟参考交付；只验证流程，不计模型能力。'}],stopReason:'end_turn'}];
  const id=`pipeline-p${pass}-${task}-${variant}`,execution=await executeCandidate(batch,task,variant,0,id,p.executionProfileHash,{mock,maxMs:120000});
  const score=await gradeInWorker(execution.runDirectory,batch.directory,p.graderRevision,p.executionProfileHash,a.workDeadline),passed=execution.executionStatus==='completed'&&score.gradeStatus==='complete'&&score.codePassed&&score.regressionPassed;
  results.push({pass,task,variant,id,passed,execution,score});persist();console.log(JSON.stringify({id,passed}));if(!passed)throw Error('分离执行/评分流水线未通过');
 }complete=true;
}finally{persist();save(join(batch.directory,'results.json'),results.map(x=>x.execution));writeTraceIndex(batch.directory);await docker(['rm','-f',batch.relay],undefined,true)}
