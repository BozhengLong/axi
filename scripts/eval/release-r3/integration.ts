import {readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {initialize,createRuntime,destroyRuntime,save,execute,docker,relayConsole,type Runtime} from './core.ts';
import {runAxiV1} from './v1-adapter.ts';
import {sealBatchTraces} from './seal.ts';
import {startGuardian} from './guardian.ts';
import {readEvents} from './trace.ts';

const [studyArg,label]=process.argv.slice(2);if(!studyArg||!label||!/^integration-[0-9]+$/.test(label))throw Error('需要研究目录与新集成编号');
const study=resolve(studyArg),out=join(study,label);mkdirSync(out);
const candidate=JSON.parse(readFileSync(join(study,'candidate.json'),'utf8'));
const batch=await initialize(study,join(study,process.argv[4]??'bundle-1'),'mock',b=>save(join(out,'batch.json'),b));save(join(out,'batch.json'),batch);
const empty=join(out,'empty');mkdirSync(empty);
const text=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'});
const tool=(id:string,name:string,input:any)=>({content:[{type:'tool_use',id,name,input}],stopReason:'tool_use'});
const mock=Array.from({length:76},(_,i)=>{
  const n=i+1;return n===1?tool('create','write',{path:'kept.txt',content:'saved'}):n===40?{content:[],stopReason:'end_turn',raw:'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"synthetic busy"}}\n\n'}:n===62?text('WORK_DONE'):n===76?text('REVIEW_DONE'):tool('read-'+n,'read',{path:'kept.txt'});
});
let runtime:Runtime|undefined,sealed=false,guardian:Awaited<ReturnType<typeof startGuardian>>|undefined;
try{
  const deadline=Date.now()+60000;
  runtime=await createRuntime(batch,'long-v1',{executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:deadline},mock,
    mounts:[`type=bind,src=${candidate.worktree},dst=/opt/axi-c3,readonly`,...['/opt/axi','/opt/c6','/opt/axi-current'].map(dst=>`type=bind,src=${empty},dst=${dst},readonly`)]});
  guardian=await startGuardian(batch,runtime,deadline);
  let checkpoint=0;
  const result=await runAxiV1(batch,runtime,['请完成指定任务。'],{getStopCause:()=>guardian!.cause,axiEntry:'/opt/axi-c3/src/main.ts',maxMs:50000,observeReview:true,reviewMode:'auto',onReviewCheckpoint:async native=>{checkpoint++;save(join(runtime!.directory,'review-observed.json'),native);},onRound:async()=>({snapshot:{}})});
  save(join(out,'execution.json'),result);
  const file=await execute(runtime,['cat','/task/kept.txt']);assert.equal(file.stdout,'saved');
  await guardian.finish();await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);sealed=true;
  assert.equal(result.status,'completed',result.error??'');assert.equal(result.proxy.meter.forwardedGeneration,76);assert.equal(result.proxy.responseCount,75);assert.equal(checkpoint,1);
  const counts:Record<string,number>={};readEvents(join(batch.directory,'relay',runtime.id+'.chunks'),e=>{counts[e.kind]=(counts[e.kind]??0)+1;});
  assert.equal(counts.request,76);assert.equal(counts.complete_response,75);assert.equal(counts.permission,1);
  save(join(out,'result.json'),{qualified:true,candidate:candidate.candidate,requests:76,responses:75,checkpoint,relayCounts:counts,traceDirectory:runtime.directory,mockOnly:true});
  console.log(JSON.stringify({qualified:true,requests:76,responses:75,traceDirectory:runtime.directory}));
}catch(error){save(join(out,'failure.json'),{error:String(error),stack:error instanceof Error?error.stack:undefined,sealed});throw error;}
finally{
  await guardian?.finish();
  if(runtime&&!sealed){try{await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);}catch(error){save(join(out,'cleanup-error.json'),{error:String(error)});}}
  if(!sealed)await relayConsole(batch);await docker(['rm','-f',batch.relay],undefined,true);
}
