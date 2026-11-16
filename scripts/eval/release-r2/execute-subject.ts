import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {initialize,createRuntime,destroyRuntime,execute,docker,command,save,type Runtime} from '../core.ts';
import {runAxi,runClaude} from '../adapters.ts';
import {runAxiV1} from '../v1/adapter.ts';
import {captureTask} from './capture.ts';
import {sealBatchTraces} from './seal.ts';

// 模拟和正式任务共用这一执行路径。真实入口还须提供控制器已经claim的身份。
export async function executeSubject(study:string,taskId:string,product:'v0'|'v1'|'claude',id:string,out:string,options:{mock?:any[];prompt:string;maxMs?:number;claim?:{ledgerPath:string;id:string;token:string}}){
 assert(/^(T\d\d|C7-[LO])$/.test(taskId)&&/^[a-z0-9-]+$/.test(id));
 const auth=JSON.parse(readFileSync(join(study,'authorization.json'),'utf8'));
 if(options.mock){assert.equal(auth.T1,null);assert.equal(process.env.ANTHROPIC_API_KEY,'synthetic-local-key');assert.equal(process.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');assert(Date.now()<Date.parse(auth.preparationDeadline))}
 else {
  // 正式控制器接线完成前保持关闭，不能凭一个伪造的claim对象启动模型。
  throw Error('正式控制器尚未取得全链路资格');
 }
 const task=join(study,taskId.startsWith('C7-')?'c7':'tasks',taskId),profile=JSON.parse(readFileSync(join(task,'qualification-profile.json'),'utf8'));
 assert.equal(process.env.AXI_EVAL_IMAGE,profile.image);
 assert(!existsSync(join(out,'seed')));
 save(join(out,'prepare.json'),await command(['python3',join(import.meta.dir,'prepare-runtime.py'),study,taskId,join(out,'seed')]));
 const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c2,readonly`,`type=bind,src=${join(study,'v0-runtime')},dst=/opt/axi-v0,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
 for(const m of profile.dependencyMounts??[])mounts.push(`type=bind,src=${join(study,m.source)},dst=${m.target},readonly`);
 for(const path of profile.dependencyPaths??[])mounts.push(`type=volume,src=${profile.dependencyVolume},dst=/task/${path},volume-subpath=${path},readonly`);
 const batch=await initialize();save(join(out,'batch.json'),{id:batch.id,directory:batch.directory,image:batch.image});
 const volume=`axi-r2-subject-${batch.id}-${id}`;let runtime:Runtime|undefined,sealed=false;
 try{
  await docker(['volume','create','--label','axi.eval.study='+study.split('/').at(-1),volume]);
  await docker(['run','--rm','--network','none','--user','0','--read-only','--cap-drop=ALL','--cap-add=CHOWN','-v',volume+':/task','--entrypoint','chown',batch.image,'1000:1000','/task']);
  await docker(['run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','-v',volume+':/task','-v',join(out,'seed')+':/seed:ro','--entrypoint','cp',batch.image,'-R','-P','--preserve=mode','/seed/.','/task/']);
  runtime=await createRuntime(batch,id,{mounts,taskVolume:volume,mock:options.mock,maxTotal:50,taskEnv:profile.environment,taskTmpfs:profile.cacheTmpfs});
  const initial=await captureTask(batch,runtime,'initial');save(join(out,'initial-snapshot.json'),initial);
  const identity=JSON.parse(readFileSync(join(study,product==='v0'?'v0-source.json':'candidate-source.json'),'utf8'));
  const files=identity.files.filter((f:any)=>f.path.startsWith('src/')||f.path==='package.json'),entry=product==='v0'?'/opt/axi-v0':'/opt/axi-c2';
  const probe=await execute(runtime,['bun','-e',`import{readFileSync,readdirSync,existsSync}from'node:fs';for(const f of await Bun.stdin.json())if(new Bun.CryptoHasher('sha256').update(readFileSync(${JSON.stringify(entry)}+'/'+f.path)).digest('hex')!==f.sha256)throw Error('source mismatch');if(process.getuid()!==1000||readdirSync('/opt/c6').length||existsSync('/var/run/docker.sock'))throw Error('isolation mismatch');console.log('frozen source identity verified')`],JSON.stringify(files));
  save(join(runtime.directory,'source-identity.json'),{sourceHash:identity.sourceHash,result:probe});
  let checkpoint:any;
  const runOptions:any={maxMs:options.maxMs??30*60_000,onRound:async()=>({snapshot:(await captureTask(batch,runtime!,'round')).files})};
  if(product==='v1')Object.assign(runOptions,{axiEntry:'/opt/axi-c2/src/main.ts',reviewMode:'auto',observeReview:true,onReviewCheckpoint:async(native:any)=>{assert(!checkpoint);save(join(runtime!.directory,'checkpoint-native.json'),native);checkpoint=await captureTask(batch,runtime!,'checkpoint');save(join(out,'checkpoint-snapshot.json'),checkpoint)}});
  else if(product==='v0')runOptions.axiEntry='/opt/axi-v0/src/main.ts';
  const execution=await(product==='v1'?runAxiV1:product==='v0'?runAxi:runClaude)(batch,runtime,[options.prompt],runOptions);
  const final=await captureTask(batch,runtime,'final');save(join(out,'final-snapshot.json'),final);
  let checks:any[]=[];
  if(options.mock){const proof=await execute(runtime,['cat','/tmp/axi-pipeline-checks.json'],undefined,true);save(join(runtime.directory,'mock-checks-process.json'),proof);checks=proof.exitCode===0?JSON.parse(proof.stdout):[];save(join(out,'mock-checks.json'),checks)}
  await destroyRuntime(batch,runtime);await sealBatchTraces(batch,[runtime]);sealed=true;
  save(join(out,'execution-result.json'),{execution,traceDirectory:runtime.directory,checkpointCaptured:!!checkpoint,batch:batch.id});
  return {execution,initial,final,checkpoint,checks,traceDirectory:runtime.directory,batchId:batch.id};
 }catch(error){save(join(out,'execution-failure.json'),{error:String(error),stack:error instanceof Error?error.stack:undefined});throw error}
 finally{
  let sealError:string|undefined;
  if(runtime){const state=await docker(['ps','-a','--filter',`name=^/${runtime.name}$`,'--format','{{.Names}}'],undefined,true);if(state.stdout.trim())await destroyRuntime(batch,runtime);
   if(!sealed){try{await sealBatchTraces(batch,[runtime]);sealed=true}catch(error){sealError=String(error);save(join(out,'seal-error.json'),{error:sealError})}}}
  await docker(['rm','-f',batch.relay],undefined,true);
  const cleanup=await docker(['volume','rm',volume],undefined,true),remaining=await docker(['volume','inspect',volume],undefined,true);
  const complete=remaining.exitCode!==0&&/No such|not found/i.test(remaining.stderr);save(join(out,'cleanup.json'),{complete,result:cleanup,verification:remaining,traceSealed:sealed});
  assert(complete,'CLI任务卷清理未完成');if(runtime)assert(sealed,sealError??'CLI Trace未最终封存');
 }
}
