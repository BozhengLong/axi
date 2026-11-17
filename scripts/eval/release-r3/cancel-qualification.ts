import {mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {initialize,createRuntime,destroyRuntime,execute,control,save,docker,relayConsole,type Runtime} from './core.ts';
import {runAxiV1} from './v1-adapter.ts';
import {sealBatchTraces} from './seal.ts';
import {startGuardian} from './guardian.ts';
import {JsonLines} from './json-lines.ts';
import {readEvents} from './trace.ts';

const [studyArg,label,bundleLabel]=process.argv.slice(2);if(!studyArg||!/^cancel-qualification-\d+$/.test(label??'')||!bundleLabel)throw Error('需要新取消资格标签');
const study=resolve(studyArg),out=join(study,label!);mkdirSync(out);
const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c3,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
const text=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'}),write={content:[{type:'tool_use',id:'once',name:'write',input:{path:'kept.txt',content:'kept after cancellation\n'}}],stopReason:'tool_use'};
const rows=[];
for(const kind of ['request','backoff','review']){
 const batch=await initialize(study,join(study,bundleLabel),'mock',b=>save(join(out,kind+'-batch.json'),b));let runtime:Runtime|undefined,sealed=false,guardian:Awaited<ReturnType<typeof startGuardian>>|undefined,monitor:Promise<void>|undefined,monitorDone=false;
 try{
  const mock=[write,...(kind==='review'?[text('WORK_DONE')]:[]),kind==='backoff'?{...text(''),status:429,raw:'temporary',headers:{'retry-after':'30'}}:{...text('CANCELLED_RESPONSE'),delayMs:10000},text('NEXT_TURN_DONE')];
  const deadline=Date.now()+60000;
  runtime=await createRuntime(batch,kind,{mounts,mock,executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:deadline}});
  guardian=await startGuardian(batch,runtime,deadline);
  if(kind!=='review')monitor=(async()=>{
   const until=performance.now()+20000;
   while(!monitorDone&&performance.now()<until){const state=await control(batch,'state',{id:runtime!.id});if(state.meter.forwardedGeneration===2&&(kind==='request'?state.activeRequests===1:state.activeRequests===0)){save(join(runtime!.directory,'cancel-trigger.json'),state);await execute(runtime!,['touch','/tmp/interrupt-now']);return;}await Bun.sleep(20);}
   if(!monitorDone)throw Error('未到达指定取消阶段');
  })();
  const execution=await runAxiV1(batch,runtime,['执行任务并保留已完成文件。','继续下一项任务。'],{getStopCause:()=>guardian!.cause,axiEntry:'/opt/axi-c3/src/main.ts',maxMs:30000,reviewMode:'auto',observeReview:true,interruptOnReview:kind==='review',interruptMarker:kind==='review'?undefined:'/tmp/interrupt-now',onRound:async()=>({snapshot:{}})});
  monitorDone=true;await monitor;
  assert.equal((await execute(runtime,['cat','kept.txt'])).stdout,'kept after cancellation\n');
  await guardian.finish();await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);sealed=true;
  const native=JSON.parse(readFileSync(join(runtime.directory,'native/manifest.json'),'utf8')),file=native.files.find((f:any)=>f.path.startsWith('axi-session/'));
  const ends:any[]=[],errors:any[]=[],results:any[]=[],responses:any[]=[];let cancel=0,permissions=0;
  const parser=new JsonLines(e=>{if(e.kind==='task_end')ends.push(e.data);if(e.kind==='request_error')errors.push(e.data);if(e.kind==='tool_result')results.push(e.data);if(e.kind==='cancel_requested')cancel++;});
  for await(const b of Bun.file(join(runtime.directory,'native',file.path)).stream())parser.write(b);parser.finish();
  readEvents(join(batch.directory,'relay',kind+'.chunks'),e=>{if(e.kind==='complete_response')responses.push(e.data);if(e.kind==='permission')permissions++;});
  assert.equal(execution.status,'completed',execution.error??'');assert.equal(execution.turns.length,2);assert.equal(execution.turns[1],'NEXT_TURN_DONE');assert.deepEqual(ends.map(e=>e.outcome),['interrupted','completed']);assert.equal(cancel,1);assert.equal(permissions,1);assert(!responses.some(r=>JSON.stringify(r).includes('CANCELLED_RESPONSE')));
  const row={kind,qualified:true,ends:ends.map(e=>e.outcome),cancel,permissions,requestErrors:errors.length,toolResults:results.length,traceDirectory:runtime.directory};rows.push(row);save(join(out,'results.json'),{qualified:rows.length===3,rows});console.log(JSON.stringify(row));
 }catch(error){save(join(out,kind+'-failure.json'),{error:String(error),stack:error instanceof Error?error.stack:undefined,sealed});throw error;}
 finally{await guardian?.finish();monitorDone=true;await monitor?.catch(()=>{});if(runtime&&!sealed)try{await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);}catch(e){save(join(out,kind+'-cleanup-error.json'),{error:String(e)});}if(!sealed){await relayConsole(batch);await docker(['rm','-f',batch.relay],undefined,true);}}
}
