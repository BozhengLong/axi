import {mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {initialize,createRuntime,destroyRuntime,save,docker,relayConsole,type Runtime} from './core.ts';
import {startGuardian} from './guardian.ts';
import {runAxiV1} from './v1-adapter.ts';
import {runAxi,runClaude} from './adapters.ts';
import {sealBatchTraces} from './seal.ts';
import {readEvents} from './trace.ts';

const [studyArg,label,bundleLabel]=process.argv.slice(2);if(!studyArg||!/^guard-qualification-\d+$/.test(label??'')||!bundleLabel)throw Error('需要新资格标签');
const study=resolve(studyArg),out=join(study,label!);mkdirSync(out);
const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c4,readonly`,`type=bind,src=${join(study,'v0-runtime')},dst=/opt/axi-v0,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
const rows=[];
for(const actor of ['v0','v1','claude'])for(const reason of ['deadline','resource']){
 const id=actor+'-'+reason,batch=await initialize(study,join(study,bundleLabel),'mock',b=>save(join(out,id+'-batch.json'),b));
 let runtime:Runtime|undefined,sealed=false,guard:Awaited<ReturnType<typeof startGuardian>>|undefined;
 try{
  const deadline=Date.now()+5000;
  runtime=await createRuntime(batch,id,{mounts,mock:[{content:[{type:'text',text:'LATE'}],stopReason:'end_turn',delayMs:30000}],executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:reason==='deadline'?deadline:Date.now()+60000}});
  guard=await startGuardian(batch,runtime,deadline,reason==='resource'?{mockLowSpaceAfterMs:2000}:{});
  const options:any={maxMs:15000,getStopCause:()=>guard!.cause,onRound:async()=>({snapshot:{}})};
  if(actor==='v1')Object.assign(options,{axiEntry:'/opt/axi-c4/src/main.ts',reviewMode:'off',observeReview:true});
  if(actor==='v0')options.axiEntry='/opt/axi-v0/src/main.ts';
  const execution=await(actor==='v1'?runAxiV1:actor==='v0'?runAxi:runClaude)(batch,runtime,['等待受控回复'],options);
  await guard.finish();
  await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);sealed=true;
  const stop=JSON.parse(readFileSync(join(runtime.directory,'guardian-result.json'),'utf8')).stop;
  assert.equal(stop.reason,reason);assert(stop.processStoppedMs<=5000);assert.equal(stop.killed.exitCode,0);
  assert.equal(execution.status,reason==='deadline'?'task_timeout':'resource_interrupted');
  let responses=0,finished:any;
  readEvents(join(batch.directory,'relay',id+'.chunks'),e=>{if(e.kind==='complete_response')responses++;});
  readEvents(join(runtime.directory,'io.chunks'),e=>{if(e.kind==='finish')finished=e.data;});
  assert.equal(responses,0);assert.equal(finished.status,execution.status);
  const row={actor,reason,qualified:true,status:execution.status,stopMs:stop.processStoppedMs,traceDirectory:runtime.directory};rows.push(row);save(join(out,'results.json'),{qualified:rows.length===6,rows});console.log(JSON.stringify(row));
 }catch(error){save(join(out,id+'-failure.json'),{error:String(error),sealed});throw error;}
 finally{await guard?.finish();if(runtime&&!sealed)try{await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);}catch(e){save(join(out,id+'-cleanup-error.json'),{error:String(e)});}if(!sealed){await relayConsole(batch);await docker(['rm','-f',batch.relay],undefined,true);}}
}
