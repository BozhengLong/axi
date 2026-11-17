import {mkdirSync,readFileSync,statSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {initialize,createRuntime,destroyRuntime,execute,save,docker,relayConsole,type Runtime} from './core.ts';
import {runAxiV1} from './v1-adapter.ts';
import {runAxi,runClaude} from './adapters.ts';
import {sealBatchTraces} from './seal.ts';
import {readEvents,fileHash} from './trace.ts';

const [studyArg,label,bundleLabel,selected='short']=process.argv.slice(2);
if(!studyArg||!label||!/^runtime-qualification-\d+$/.test(label)||!bundleLabel)throw Error('需要研究目录、新证据编号及固定bundle');
const study=resolve(studyArg),out=join(study,label);mkdirSync(out);
const text=(value:string)=>({content:[{type:'text',text:value}],stopReason:'end_turn'});
const tool=(id:string,name:string,input:any)=>({content:[{type:'tool_use',id,name,input}],stopReason:'tool_use'});
const busy=(status=429)=>({content:[],stopReason:'end_turn',status,headers:{'retry-after':'0'},raw:'synthetic temporary error'});
const short=['off-long','http40-http50','retry429-expiry','retry503-expiry','transport-expiry','late-response','v0-native50','v0-truncated','claude-truncated'];
const cases=selected==='short'?short:selected==='large'?['large-trace']:[selected];
const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c3,readonly`,`type=bind,src=${join(study,'v0-runtime')},dst=/opt/axi-v0,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
save(join(out,'source.json'),{files:['runtime-qualification.ts','relay.ts','core.ts','adapters.ts','v1-adapter.ts','trace.ts','seal.ts','execution-evidence.py'].map(p=>({path:p,sha256:fileHash(join(import.meta.dir,p))})),bundle:JSON.parse(readFileSync(join(study,bundleLabel,'manifest.json'),'utf8')),cases,mockOnly:true});
const archive=join(out,'source-archive');mkdirSync(archive);for(const f of JSON.parse(readFileSync(join(out,'source.json'),'utf8')).files)copyFileSync(join(import.meta.dir,f.path),join(archive,f.path));
const rows:any[]=[];
for(const kind of cases){
 const batch=await initialize(study,join(study,bundleLabel),'mock',b=>save(join(out,kind+'-batch.json'),b));
 let runtime:Runtime|undefined,sealed=false,volume:string|undefined;
 try{
  let mock:any[],reviewMode:'auto'|'off'='off',windowMs:number|undefined,maxMs=90000,expected='completed';
  if(kind==='off-long')mock=[...Array.from({length:75},(_,i)=>tool('read-'+i,'read',{path:'kept.txt'})),text('DONE')];
  else if(kind==='http40-http50'){
   reviewMode='auto';mock=Array.from({length:76},(_,i)=>i===0?tool('write','write',{path:'created.txt',content:'one write\n'}):i===39||i===49?busy():i===61||i===75?text(i===61?'WORK_DONE':'REVIEW_DONE'):tool('read-'+i,'read',{path:'kept.txt'}));
  }else if(kind==='large-trace'){
   mock=[{...busy(),raw:'X'.repeat(8000),repeat:28000},text('DONE')];maxMs=600000;
   volume='axi-'+batch.id+'-large';await docker(['volume','create','--label','axi.eval.batch='+batch.id,volume]);
  }else if(kind==='v0-native50')mock=[...Array.from({length:51},(_,i)=>tool('read-'+i,'bash',{command:'cat kept.txt'})),text('UNREACHABLE')],expected='product_error';
  else if(kind==='v0-truncated'||kind==='claude-truncated')mock=[{...text('NOT_FINISHED'),stopReason:'max_tokens'}],expected=kind.startsWith('v0')?'candidate_unfinished':'product_or_runner_error';
  else{
   windowMs=150;expected='retry_exhausted';
   mock=kind==='late-response'?[{...text('LATE'),delayMs:2000}]:kind==='transport-expiry'?[{...text(''),connectionError:true,repeat:1000}]:[{...busy(kind==='retry503-expiry'?503:429),repeat:1000}];
  }
  runtime=await createRuntime(batch,kind,{mounts,mock,files:{'kept.txt':'original\n'},taskVolume:volume,mockRetryWindowMs:windowMs,executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:Date.now()+maxMs+10000}});
  let checkpoints=0;
  const options:any={maxMs,onRound:async()=>({snapshot:{}})};
  const actor=kind.startsWith('v0')?'v0':kind.startsWith('claude')?'claude':'v1';
  if(actor==='v1')Object.assign(options,{axiEntry:'/opt/axi-c3/src/main.ts',reviewMode,observeReview:true,onReviewCheckpoint:async()=>{checkpoints++;}});
  if(actor==='v0')options.axiEntry='/opt/axi-v0/src/main.ts';
  const execution=await(actor==='v1'?runAxiV1:actor==='v0'?runAxi:runClaude)(batch,runtime,['请完成指定任务。'],options);
  assert.equal((await execute(runtime,['cat','/task/kept.txt'])).stdout,'original\n');
  await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);sealed=true;
  const counts:Record<string,number>={};let total=0;
  readEvents(join(batch.directory,'relay',runtime.id+'.chunks'),e=>{counts[e.kind]=(counts[e.kind]??0)+1;total++;});
  const terminalBytes=statSync(execution.stdoutPath).size;
  const native=JSON.parse(readFileSync(join(runtime.directory,'native/manifest.json'),'utf8'));
  const row={kind,actor,status:execution.status,error:execution.error,requests:counts.request,responses:counts.complete_response??0,checkpoints,events:total,terminalBytes,nativeBytes:native.files.reduce((n:number,f:any)=>n+f.bytes,0),traceDirectory:runtime.directory};
  save(join(out,kind+'.json'),row);
  assert.equal(execution.status,expected,JSON.stringify(row));
  if(kind==='off-long')assert.equal(counts.request,76),assert.equal(checkpoints,0);
  if(kind==='http40-http50')assert.equal(counts.request,76),assert.equal(counts.complete_response,74),assert.equal(checkpoints,1);
  if(kind==='v0-native50')assert.equal(counts.request,50);
  if(kind==='late-response')assert.equal(counts.complete_response??0,0);
  if(kind==='large-trace')assert.equal(counts.request,28001),assert(total>100000),assert(terminalBytes>200*1024*1024),assert(row.nativeBytes>128*1024*1024),assert(!counts.truncated);
  rows.push({...row,qualified:true});save(join(out,'results.json'),{qualified:rows.length===cases.length,rows});console.log(JSON.stringify(rows.at(-1)));
 }catch(error){save(join(out,kind+'-failure.json'),{error:String(error),stack:error instanceof Error?error.stack:undefined,sealed});throw error;}
 finally{
  if(runtime&&!sealed){try{await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);}catch(error){save(join(out,kind+'-cleanup-error.json'),{error:String(error)});}}
  if(!sealed){await relayConsole(batch);await docker(['rm','-f',batch.relay],undefined,true);}
  if(volume&&sealed)await docker(['volume','rm',volume]);
 }
}
