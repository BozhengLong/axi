import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {initialize,createRuntime,destroyRuntime,execute,docker,command,save,type Runtime} from './core.ts';
import {runAxi,runClaude} from './adapters.ts';
import {runAxiV1} from './v1-adapter.ts';
import {captureTask} from '../release-r2/capture.ts';
import {sealBatchTraces} from './seal.ts';
import {startGuardian} from './guardian.ts';
import {fileHash} from './trace.ts';

// 模拟和正式任务共用这一执行路径。真实入口还须提供控制器已经claim的身份。
export async function executeSubject(study:string,taskId:string,product:'v0'|'v1'|'claude',id:string,out:string,options:{mock?:any[];prompt:string;maxMs?:number;claim?:{mode:'mock'|'real';id:string;ledgerLabel?:string}}){
 assert(/^(health|U\d\d|C7-[LO])$/.test(taskId)&&/^[a-z0-9-]+$/.test(id));
 const auth=JSON.parse(readFileSync(join(study,'authorization.json'),'utf8'));
 let qualificationDeadline=Infinity;
 if(options.mock){assert(process.env.ANTHROPIC_API_KEY==='synthetic-local-key','模拟入口必须使用合成认证配置');assert(process.env.ANTHROPIC_BASE_URL==='http://127.0.0.1:1','模拟入口必须使用本地无上游配置');const gate=await command(['python3',join(import.meta.dir,'qualification_guard.py'),study,taskId]);qualificationDeadline=Date.parse(JSON.parse(gate.stdout).deadline);assert(Date.now()<qualificationDeadline)}
 else {assert(options.claim?.mode==='real','正式执行缺少控制器claim');assert(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_API_KEY!=='synthetic-local-key','正式执行没有真实上游配置')}
 assert(options.claim && options.claim.mode===(options.mock?'mock':'real'),'执行与控制器模式不符');
 const admission=await command(['python3',join(import.meta.dir,'controller-gateway.py')],JSON.stringify({study,action:'launched',mode:options.claim.mode,payload:{id:options.claim.id,task:taskId,product,pid:process.pid,...(options.claim.ledgerLabel?{ledgerLabel:options.claim.ledgerLabel}:{})}}));
 const authority=JSON.parse(admission.stdout);assert(authority.authorized);save(join(out,'launch-admission.json'),authority);
 const task=taskId==='health'?join(study,'health'):join(study,taskId.startsWith('C7-')?'c7':'tasks',taskId),profile=JSON.parse(readFileSync(join(task,'qualification-profile.json'),'utf8'));
 assert.equal(process.env.AXI_EVAL_IMAGE,profile.image);
 assert(!existsSync(join(out,'seed')));
 save(join(out,'prepare.json'),await command(['python3',join(import.meta.dir,'../release-r2/prepare-runtime.py'),study,taskId,join(out,'seed')]));
 const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c3,readonly`,`type=bind,src=${join(study,'v0-runtime')},dst=/opt/axi-v0,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
 for(const m of profile.dependencyMounts??[])mounts.push(`type=bind,src=${join(study,m.source)},dst=${m.target},readonly`);
 for(const path of profile.dependencyPaths??[])mounts.push(`type=volume,src=${profile.dependencyVolume},dst=/task/${path},volume-subpath=${path},readonly`);
 // 固定只读依赖可直接加载；避免Nx将原生模块复制到noexec的/tmp后退回不完整WASM。
 const taskEnv={...(profile.environment??{})};
 if(taskEnv.NX_CACHE_DIRECTORY)taskEnv.NX_SKIP_NATIVE_FILE_CACHE='true';
 save(join(out,'runtime-environment.json'),{taskEnv,taskTmpfs:profile.cacheTmpfs??[],defaultTmp:'/tmp:rw,nosuid,size=256m,mode=1777',nativeDependencies:'readonly pinned mounts'});
 const recordBatch=(b:any)=>save(join(out,'batch.json'),{id:b.id,directory:b.directory,image:b.image,relay:b.relay,runtimeId:id});
 const bundleIdentity=JSON.parse(readFileSync(join(study,'active-bundle.json'),'utf8'));assert(/^bundle-\d+$/.test(bundleIdentity.label));const bundle=join(study,bundleIdentity.label);assert.equal(fileHash(join(bundle,'manifest.json')),bundleIdentity.sha256);
 const batch=await initialize(study,bundle,options.mock?'mock':'real',recordBatch);recordBatch(batch);
 const volume=`axi-r3-subject-${batch.id}-${id}`;let runtime:Runtime|undefined,sealed=false,guard:Awaited<ReturnType<typeof startGuardian>>|undefined;
 try{
  await docker(['volume','create','--label','axi.eval.study='+study.split('/').at(-1),volume]);
  await docker(['run','--rm','--network','none','--user','0','--read-only','--cap-drop=ALL','--cap-add=CHOWN','-v',volume+':/task','--entrypoint','chown',batch.image,'1000:1000','/task']);
  await docker(['run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','-v',volume+':/task','-v',join(out,'seed')+':/seed:ro','--entrypoint','cp',batch.image,'-R','-P','--preserve=mode','/seed/.','/task/']);
  runtime=await createRuntime(batch,id,{mounts,taskVolume:volume,mock:options.mock,executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:Math.floor(authority.claim.executionDeadline*1000)},taskEnv,taskTmpfs:profile.cacheTmpfs});
  guard=await startGuardian(batch,runtime,Math.floor(authority.claim.executionDeadline*1000));
  const initial=await captureTask(batch,runtime,'initial');save(join(out,'initial-snapshot.json'),initial);
  const identity=JSON.parse(readFileSync(join(study,product==='v0'?'v0-source.json':'candidate-source.json'),'utf8'));
  const files=identity.files.filter((f:any)=>f.path.startsWith('src/')||f.path==='package.json'),entry=product==='v0'?'/opt/axi-v0':'/opt/axi-c3';
  const probe=await execute(runtime,['bun','-e',`import{readFileSync,readdirSync,existsSync}from'node:fs';for(const f of await Bun.stdin.json())if(new Bun.CryptoHasher('sha256').update(readFileSync(${JSON.stringify(entry)}+'/'+f.path)).digest('hex')!==f.sha256)throw Error('source mismatch');if(process.getuid()!==1000||readdirSync('/opt/c6').length||existsSync('/var/run/docker.sock'))throw Error('isolation mismatch');console.log('frozen source identity verified')`],JSON.stringify(files));
  save(join(runtime.directory,'source-identity.json'),{sourceHash:identity.sourceHash,result:probe});
  let checkpoint:any;
  const remainingMs=authority.claim.executionDeadline*1000-Date.now();assert(remainingMs>0,'执行剩余窗口不足');
  const runOptions:any={getStopCause:()=>guard!.cause,maxMs:Math.min(options.maxMs??30*60_000,remainingMs,qualificationDeadline-Date.now()-10_000),onRound:async()=>({snapshot:(await captureTask(batch,runtime!,'round')).files})};
  if(product==='v1')Object.assign(runOptions,{axiEntry:'/opt/axi-c3/src/main.ts',reviewMode:'auto',observeReview:true,onReviewCheckpoint:async(native:any)=>{assert(!checkpoint);save(join(runtime!.directory,'checkpoint-native.json'),native);checkpoint=await captureTask(batch,runtime!,'checkpoint');save(join(out,'checkpoint-snapshot.json'),checkpoint)}});
  else if(product==='v0')runOptions.axiEntry='/opt/axi-v0/src/main.ts';
  const execution=await(product==='v1'?runAxiV1:product==='v0'?runAxi:runClaude)(batch,runtime,[options.prompt],runOptions);
  await guard.finish();
  const final=await captureTask(batch,runtime,'final');save(join(out,'final-snapshot.json'),final);
  let checks:any[]=[];
  if(options.mock){const proof=await execute(runtime,['cat','/tmp/axi-pipeline-checks.json'],undefined,true);save(join(runtime.directory,'mock-checks-process.json'),proof);checks=proof.exitCode===0?JSON.parse(proof.stdout):[];save(join(out,'mock-checks.json'),checks)}
  await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);sealed=true;
  const audit=await command(['python3',join(import.meta.dir,'execution-evidence.py'),runtime.directory,...(options.mock?['--mock']:[])]);save(join(out,'execution-evidence.json'),JSON.parse(audit.stdout));
  const inputEvidence=await command(['python3',join(import.meta.dir,'input-evidence.py'),runtime.directory,join(out,'prompt.json'),...(options.mock&&execution.status==='completed'?['--require-document']:[])]);save(join(out,'input-evidence.json'),JSON.parse(inputEvidence.stdout));
  save(join(out,'execution-result.json'),{execution,traceDirectory:runtime.directory,checkpointCaptured:!!checkpoint,batch:batch.id});
  return {execution,initial,final,checkpoint,checks,traceDirectory:runtime.directory,batchId:batch.id};
 }catch(error){save(join(out,'execution-failure.json'),{error:String(error),stack:error instanceof Error?error.stack:undefined});throw error}
 finally{
  await guard?.finish();
  let sealError:string|undefined;
  if(runtime){const state=await docker(['ps','-a','--filter',`name=^/${runtime.name}$`,'--format','{{.Names}}'],undefined,true);if(state.stdout.trim())await destroyRuntime(batch,runtime);
   if(!sealed){try{await sealBatchTraces(batch,[runtime]);sealed=true}catch(error){sealError=String(error);save(join(out,'seal-error.json'),{error:sealError})}}}
  await docker(['rm','-f',batch.relay],undefined,true);
  const cleanup=sealed||!runtime?await docker(['volume','rm',volume],undefined,true):{preserved:true,reason:'trace-not-sealed'},remaining=await docker(['volume','inspect',volume],undefined,true);
  const complete=remaining.exitCode!==0&&/No such|not found/i.test(remaining.stderr);save(join(out,'cleanup.json'),{complete,result:cleanup,verification:remaining,traceSealed:sealed});
  assert(complete,'CLI任务卷清理未完成');if(runtime)assert(sealed,sealError??'CLI Trace未最终封存');
 }
}
