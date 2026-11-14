import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {initialize,createRuntime,destroyRuntime,execute,save,docker} from '../core.ts';
import {runAxi} from '../adapters.ts';
import {runAxiV1} from '../v1/adapter.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {classifyExecution} from '../c7/outcome.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
authorization();
const batch=await initialize(),frozen=fingerprint(),results:any[]=[];let complete=false;
const limit="This request would exceed your account's rate limit. Please try again later.";
const wire=(raw:unknown)=>'data: '+JSON.stringify({type:'error',error:raw})+'\n\n';
const fail=(error:unknown=limit)=>({content:[],stopReason:'end_turn',raw:wire(error)});
const call={content:[{type:'tool_use',id:'once',name:'bash',input:{command:'printf once >> marker.txt'}}],stopReason:'tool_use'};
const done={content:[{type:'text',text:'done'}],stopReason:'end_turn'};
try{
 for(const kind of ['recover','exhaust','unknown','auth','cancel','budget','old']as const){
  const id='rc-protocol-'+kind;
  const partial='data: '+JSON.stringify({type:'message_start',message:{content:[]}})+'\n\n'+'data: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'never',name:'bash',input:{}}})+'\n\n'+wire(limit);
  const mock=kind==='recover'?[call,{...fail(),raw:partial},done]:kind==='exhaust'?Array.from({length:4},()=>fail()):kind==='unknown'?[fail('unrecognized rate limit')]:kind==='auth'?[fail({type:'authentication_error',message:limit})]:[fail(),done];
  const r=await createRuntime(batch,id,{mock,maxTotal:kind==='budget'?1:12});let row:any;
  try{
   const x=await(kind==='old'?runAxi:runAxiV1)(batch,r,['执行离线协议测试'],{maxMs:kind==='cancel'?600:30000,...(kind!=='old'?{reviewMode:'off' as const}:{}),...(kind==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{})});
   const events=readFileSync(join(batch.directory,'relay',id+'.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l)),requests=events.filter(e=>e.kind==='request'&&e.data?.path==='/v1/messages'),classification=classifyExecution(x.status,events);
   const marker=Buffer.from(x.snapshots.at(-1)?.['marker.txt']?.data??'','base64').toString();
   const expected=kind==='recover'?3:kind==='exhaust'?4:1;
   const passed=requests.length===expected&&(kind==='recover'?x.status==='completed'&&marker==='once'&&x.proxy.permissions.length===1&&JSON.stringify(requests[1].data.body)===JSON.stringify(requests[2].data.body):kind==='cancel'?x.status==='task_timeout':kind==='budget'?x.status==='budget_exhausted':x.status==='product_error'&&classification===(kind==='unknown'?'unclassified_failure':kind==='auth'?'authentication_failure':'environment_indeterminate'));
   row={id,kind,passed,status:x.status,classification,forwarded:requests.length,normalized:events.filter(e=>e.kind==='api_error').map(e=>e.data.normalizedError)};save(join(r.directory,'protocol-result.json'),row);
  }finally{await destroyRuntime(batch,r)}
  row.traceComplete=read(join(r.directory,'trace-manifest.json')).status==='complete_observable';row.passed&&=row.traceComplete;results.push(row);console.log(JSON.stringify(row));if(!row.passed)throw Error('协议CLI回归失败');
 }
 const r=await createRuntime(batch,'raw-bytes',{mock:[fail()]});
 try{
  const script='const r=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"x-api-key":process.env.ANTHROPIC_API_KEY,"content-type":"application/json"},body:JSON.stringify({model:"claude-opus-5-5",stream:true,messages:[]})});console.log(JSON.stringify({status:r.status,raw:await r.text()}));';
  const x=await execute(r,['bun','-e',script]),observed=JSON.parse(x.stdout);const row={id:'raw-bytes',passed:observed.status===200&&observed.raw===wire(limit),observed};results.push(row);save(join(r.directory,'raw-bytes.json'),row);if(!row.passed)throw Error('转发器改写SSE字节');
 }finally{await destroyRuntime(batch,r)}
 complete=true;
}finally{const report={complete,image:IMAGE,sourceHash:frozen.sourceHash,batch:batch.id,directory:batch.directory,results};save(join(STUDY,'protocol-smoke-latest.json'),report);save(join(batch.directory,'results.json'),results);await docker(['rm','-f',batch.relay],undefined,true)}
