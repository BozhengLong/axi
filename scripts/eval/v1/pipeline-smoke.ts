import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {ROOT,initialize,docker,save} from '../core.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {runtimeFingerprint} from './fingerprint.ts';
import {job} from './job.ts';
import {reference,taskFiles} from './tasks.ts';
import {reference as c7Reference} from '../c7/tasks.ts';
import {STUDY,IMAGE,type TaskId,type Variant} from './settings.ts';
if(process.env.AXI_EVAL_IMAGE!==IMAGE)throw Error('固定镜像');
const batch=await initialize(),frozen=fingerprint(),results:any[]=[];
for(const p of Object.keys(frozen.hashes)){const dest=join(batch.directory,'source-snapshot',p);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,p)),{mode:0o600});}
save(join(batch.directory,'manifest.json'),{suite:'v1-pipeline-mock',batch:batch.id,image:IMAGE,traceVersion:2,...frozen,...runtimeFingerprint()});
let complete=false;
try{
 for(const task of ['V1-A','V1-B','C7-L','C7-O'] as TaskId[]){for(const variant of (task.startsWith('V1-')?['old','new','claude']:['new']) as Variant[]){
  const seed=taskFiles(task),ref=task==='C7-L'||task==='C7-O'?c7Reference(task,seed):reference(task);
  const changes=Object.fromEntries(Object.entries(ref).filter(([p,e])=>JSON.stringify(e)!==JSON.stringify(seed[p])));
  // 参考产物只通过登记的模拟 API 进入这次模拟工作卷，正式候选不可见参考。
  const script='import{writeFileSync,mkdirSync}from"node:fs";import{dirname}from"node:path";const files=JSON.parse(Buffer.from("'+Buffer.from(JSON.stringify(changes)).toString('base64')+'","base64").toString());for(const[p,e]of Object.entries(files)){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,Buffer.from(e.data,"base64"),{mode:e.mode})}';
  const command="bun -e '"+script+"'";
  const mock=[{content:[{type:'tool_use',id:'mock-reference',name:variant==='claude'?'Bash':'bash',input:{command}}],stopReason:'tool_use'},{content:[{type:'text',text:'模拟交付：已写入参考修改与独立回归；本消息只用于流水线验证，不是模型能力样本。'}],stopReason:'end_turn'}];
  const id=`pipeline-${task}-${variant}`;
  const result=await job(batch,task,variant,0,id,{mock,maxMs:120000});const trace=JSON.parse(readFileSync(join(batch.directory,id,'trace-manifest.json'),'utf8'));
  const passed=result.status==='completed'&&result.codePassed&&result.regressionPassed&&trace.status==='complete_observable';results.push({task,variant,passed,result,traceStatus:trace.status});save(join(batch.directory,'results.json'),results);console.log(JSON.stringify({id,passed,failures:result.failureChecks}));if(!passed)throw Error('流水线模拟未通过');
 }}complete=true;
}finally{const report={complete,image:IMAGE,batch:batch.id,directory:batch.directory,...frozen,...runtimeFingerprint(),results};save(join(batch.directory,'pipeline-smoke.json'),report);save(join(STUDY,'pipeline-smoke-latest.json'),report);await docker(['rm','-f',batch.relay],undefined,true);}
