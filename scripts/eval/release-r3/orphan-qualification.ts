import {mkdirSync,readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {initialize,createRuntime,destroyRuntime,control,execute,save,docker,relayConsole} from './core.ts';
import {startGuardian} from './guardian.ts';
import {runAxiV1} from './v1-adapter.ts';
import {sealBatchTraces} from './seal.ts';
import {fileHash} from './trace.ts';

if(process.argv[2]==='child'){
 const {batch,runtime,deadline}=JSON.parse(readFileSync(process.argv[3]!,'utf8'));
 const guardian=await startGuardian(batch,runtime,deadline);
 await runAxiV1(batch,runtime,['等待受控长请求'],{axiEntry:'/opt/axi-c3/src/main.ts',reviewMode:'off',observeReview:true,maxMs:50000,getStopCause:()=>guardian.cause});
 await guardian.finish();
}else{
 const [studyArg,label,bundle,mode='crash']=process.argv.slice(2);if(!studyArg||!/^orphan-qualification-\d+$/.test(label??'')||!bundle||!['crash','write-failure'].includes(mode))throw Error('需要独立的新证据目录');
 const study=resolve(studyArg),out=join(study,label!);mkdirSync(out);
 const batch=await initialize(study,join(study,bundle),'mock',b=>save(join(out,'batch.json'),b));
 const deadline=Date.now()+60000;
 const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c3,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
 const mock=mode==='crash'?[{content:[{type:'text',text:'LATE'}],stopReason:'end_turn',delayMs:30000}]:[{content:[],stopReason:'end_turn',status:429,raw:'X'.repeat(8000),headers:{'retry-after':'0'},delayMs:500},{content:[],stopReason:'end_turn',status:429,raw:'X'.repeat(8000),headers:{'retry-after':'0'},repeat:1000}];
 const runtime=await createRuntime(batch,'orphan',{mounts,executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:deadline},mock});
 const config=join(out,'executor.json');save(config,{batch,runtime,deadline});
 const args=[process.execPath,import.meta.filename,'child',config];
 const child=Bun.spawn(mode==='crash'?args:['python3','-c','import resource,signal,os,sys;resource.setrlimit(resource.RLIMIT_FSIZE,(262144,262144));signal.signal(signal.SIGXFSZ,signal.SIG_IGN);os.execv(sys.argv[1],sys.argv[1:])',...args],{stdout:Bun.file(join(out,'executor.stdout')),stderr:Bun.file(join(out,'executor.stderr'))});let collected=false;
 try{
  let state:any;const until=performance.now()+10000;
  while(performance.now()<until){state=await control(batch,'state',{id:runtime.id});if(state.activeRequests===1)break;await Bun.sleep(20);}
  assert.equal(state.activeRequests,1);save(join(out,'before-crash.json'),state);
  if(mode==='crash')child.kill('SIGKILL');
  await Promise.race([child.exited,Bun.sleep(15000)]);assert.notEqual(child.exitCode,null,'故障注入后执行器仍运行');
  const crashedAt=performance.now();
  if(mode==='write-failure')assert(/EFBIG|file too large/i.test(readFileSync(join(out,'executor.stderr'),'utf8')),'未观察到真实文件写入错误');
  const resultPath=join(runtime.directory,'guardian-result.json');
  while(!existsSync(resultPath)&&performance.now()-crashedAt<10000)await Bun.sleep(20);
  assert(existsSync(resultPath));const result=JSON.parse(readFileSync(resultPath,'utf8'));
  assert.equal(result.reason,'controller_lost');assert(result.stop.processStoppedMs<=5000);assert.equal(result.stop.killed.exitCode,0);
  state=await control(batch,'state',{id:runtime.id});assert(state.revoked);assert.equal(state.activeRequests,0);assert.equal(state.responseCount,0);
  const processes=await execute(runtime,['bun','-e',"import{readdirSync,readFileSync}from'node:fs';console.log(JSON.stringify(readdirSync('/proc').filter(p=>Number(p)&&Number(p)!==1&&Number(p)!==process.pid).filter(p=>{try{return /^Uid:\\s+1000\\s/m.test(readFileSync('/proc/'+p+'/status','utf8'))&&!/^State:\\s+Z/m.test(readFileSync('/proc/'+p+'/status','utf8'))}catch{return false}})))"]);assert.deepEqual(JSON.parse(processes.stdout),[]);
  await destroyRuntime(batch,runtime);collected=true;
  let rejected='';try{await sealBatchTraces(batch,[runtime]);}catch(error){rejected=String(error);}
  assert(rejected.includes('ENOENT')||rejected.includes('未关闭'),rejected);assert(!existsSync(join(runtime.directory,'trace-manifest.json')));assert(!existsSync(join(runtime.directory,'io.chunks/manifest.json')));
  const files:any[]=[];function walk(p:string){for(const n of readdirSync(p)){const f=join(p,n);if(statSync(f).isDirectory())walk(f);else files.push({path:f.slice(batch.directory.length+1),bytes:statSync(f).size,sha256:fileHash(f)});}}walk(batch.directory);
  save(join(out,'partial-evidence.json'),{status:'incomplete-preserved',reason:'executor-killed-before-IO-finish',files});
  save(join(out,'result.json'),{qualified:true,mode,guardian:result,completeTraceRejected:rejected,processes:[],realModelStarts:0,traceDirectory:runtime.directory});console.log(JSON.stringify({qualified:true,mode,reason:result.reason,completeTraceRejected:true}));
 }catch(error){save(join(out,'failure.json'),{error:String(error)});throw error;}
 finally{child.kill('SIGKILL');await child.exited;if(!collected)try{await destroyRuntime(batch,runtime);}catch(error){save(join(out,'collection-failure.json'),{error:String(error)});}await relayConsole(batch);await docker(['rm','-f',runtime.name,batch.relay],undefined,true);await docker(['network','rm',runtime.network],undefined,true);}
}
