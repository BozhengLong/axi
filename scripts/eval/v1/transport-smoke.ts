import { STUDY } from "./settings.ts";
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {ROOT,STORE,initialize,createRuntime,destroyRuntime,control,save,docker} from '../core.ts';
import {runAxi,runClaude} from '../adapters.ts';
import {runAxiV1} from './adapter.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {classifyExecution} from '../c7/outcome.ts';
if(!process.env.AXI_EVAL_IMAGE?.startsWith('sha256:'))throw Error('模拟需要显式固定镜像');
const study=STUDY,batch=await initialize(),frozen=fingerprint(),results:any[]=[];
for(const path of Object.keys(frozen.hashes)){const target=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,readFileSync(join(ROOT,path)),{mode:0o600});}
save(join(batch.directory,'manifest.json'),{suite:'v1-transport-repair',batch:batch.id,image:batch.image,mockOnly:true,traceVersion:2,...frozen});
const failure=()=>({content:[],stopReason:'end_turn',connectionError:true});
let complete=false;
try{
 for(const kind of ['recover','exhaust','budget'] as const){for(const variant of (kind==='recover'?['old','new','claude']:['old','new']) as ('old'|'new'|'claude')[]){
  const id=`transport-${kind}-${variant}`;
  const mock=kind==='exhaust'?Array.from({length:4},failure):[failure(),{content:[{type:'tool_use',id:'recovery-write',name:variant==='claude'?'Bash':'bash',input:{command:"printf retry-ok > recovered.txt"}}],stopReason:'tool_use'},{content:[{type:'text',text:'恢复完成'}],stopReason:'end_turn'}];
  const runtime=await createRuntime(batch,id,{mock,maxRounds:2,maxTotal:kind==='budget'?1:12});
  save(join(runtime.directory,'input.json'),{kind,variant,prompt:'执行恢复测试',mock,maxTotal:kind==='budget'?1:12});
  let row:any;
  try{
   const execution=await(variant==='new'?runAxiV1:variant==='old'?runAxi:runClaude)(batch,runtime,['执行恢复测试'],{maxMs:60000,...(variant==='new'?{reviewMode:'off' as const}:{}),...(variant==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{})});
   const proxy=execution.proxy;
   const events=readFileSync(join(batch.directory,'relay',id+'.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
   let passed:boolean,roundAdvanced=false;
   if(kind==='recover'){
    const next=await control(batch,'next-round',{id,expectedRound:1});roundAdvanced=next.budget.round===2&&next.budget.generationRequests===proxy.budget.generationRequests;
    const actual=Buffer.from(execution.snapshots.at(-1)?.['recovered.txt']?.data??'','base64').toString();
    passed=execution.status==='completed'&&proxy.faults.filter((x:string)=>x==='upstream_connection').length===1&&proxy.budget.generationRequests>=3&&actual==='retry-ok'&&execution.turns.length===1&&roundAdvanced;
   }else if(kind==='exhaust')passed=execution.status==='product_error'&&classifyExecution(execution.status,events)==='environment_indeterminate'&&proxy.budget.generationRequests===4&&proxy.responses.length===0&&execution.turns.length===0;
   else passed=execution.status==='budget_exhausted'&&proxy.faults.includes('request_budget')&&proxy.budget.generationRequests===2&&proxy.responses.length===0;
   row={id,kind,variant,passed,status:execution.status,requests:proxy.budget.generationRequests,faults:proxy.faults,roundAdvanced};
   save(join(runtime.directory,'transport-result.json'),row);
  }finally{await destroyRuntime(batch,runtime);}
  const trace=JSON.parse(readFileSync(join(runtime.directory,'trace-manifest.json'),'utf8'));row.traceComplete=trace.status==='complete_observable';row.passed&&=row.traceComplete;
  results.push(row);save(join(batch.directory,'results.json'),results);console.log(JSON.stringify(row));if(!row.passed)throw Error('传输修复模拟未通过');
 }}complete=true;
}finally{const report={complete,batch:batch.id,directory:batch.directory,image:batch.image,...frozen,results};save(join(batch.directory,'transport-smoke.json'),report);save(join(study,'transport-smoke-latest.json'),report);await docker(['rm','-f',batch.relay],undefined,true);}
