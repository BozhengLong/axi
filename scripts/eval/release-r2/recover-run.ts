import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {command,docker,save,freeze,type Runtime,type Batch} from '../core.ts';
import {collectNativeTrace} from '../trace.ts';
import {captureTask} from './capture.ts';
import {verifiedHostEnvironment} from './host-environment.ts';
import {sha} from './source.ts';

// 宿主退出后的保全入口。不会补造io_finish，不重启产品，不重开已消费槽。
const [studyArg,slotId,outputArg,label]=process.argv.slice(2);assert(studyArg&&slotId&&outputArg);
const study=resolve(studyArg),out=resolve(study,outputArg);assert(out.startsWith(study+'/'));
await verifiedHostEnvironment(study);
const mode=label?'mock':'real';
const control=async(action:string,payload:any={})=>JSON.parse((await command(['python3',join(import.meta.dir,'controller-gateway.py')],JSON.stringify({study,action,mode,payload:{...payload,...(label?{ledgerLabel:label}:{})}}))).stdout);
const current=await control('status'),claim=current.state.claims[slotId];assert(claim,'没有既有任务槽');
assert(!claim.review&&!current.state.closure,'已审查或关闭的槽不由中断恢复入口处理');
const identity=claim.launch?.processIdentity;
if(identity){
 const p=await command(['ps','-p',String(identity.pid),'-o','lstart=,command='],undefined,true);
 assert(p.exitCode!==0||p.stdout.trim()!==identity.observed,'原执行进程仍存活，不能接管');
}
const recovery=join(out,'recovery');mkdirSync(recovery,{recursive:false});
save(join(recovery,'incident.json'),{at:new Date().toISOString(),slot:slotId,reason:'host-process-ended',originalProcess:identity??null,claimPreserved:true,modelRelaunched:false});
await control('pause',{reason:'interrupted-execution',incident:slotId+'-host-exit',evidence:{path:relative(study,join(recovery,'incident.json')),sha256:sha(readFileSync(join(recovery,'incident.json')))}});
const errors:any[]=[];const recordError=(step:string,e:unknown)=>errors.push({step,error:String(e)});
let resourceIdentity:any=null;
if(existsSync(join(out,'batch.json'))){
 const pointer=JSON.parse(readFileSync(join(out,'batch.json'),'utf8'));
 assert(/^b\d{14}$/.test(pointer.id)&&/^[a-z0-9-]+$/.test(pointer.runtimeId));
 const directory=resolve(pointer.directory);assert(directory.startsWith(study+'/'));
 const batch:Batch=JSON.parse(readFileSync(join(directory,'private-state.json'),'utf8'));
 assert(batch.id===pointer.id&&batch.directory===directory&&batch.relay===`axi-eval-${batch.id}-relay`&&batch.image===process.env.AXI_EVAL_IMAGE);
 const name=`axi-eval-${batch.id}-${pointer.runtimeId}`,network=name+'-net',volume=`axi-r2-subject-${batch.id}-${pointer.runtimeId}`;
 const runtime={id:pointer.runtimeId,name,network,directory:join(directory,pointer.runtimeId),taskVolume:volume} as Runtime;
 const containers=(await docker(['ps','-a','--filter','label=axi.eval.batch='+batch.id,'--format','{{.Names}}'])).stdout.trim().split('\n').filter(Boolean);
 assert(containers.every(n=>[name,batch.relay].includes(n)),'发现未登记的本批容器，先保留调查');
 resourceIdentity={batch:batch.id,containers,network,volume};
 if(containers.includes(name)){
  try{await freeze(runtime);await captureTask(batch,runtime,'interrupted');await collectNativeTrace(runtime)}catch(e){recordError('capture-interrupted',e)}
 }
 for(const n of containers){
  const logs=await docker(['logs',n],undefined,true);save(join(recovery,n+'-logs.json'),logs);
  const state=await docker(['inspect',n,'--format','{{json .State}}'],undefined,true);save(join(recovery,n+'-state.json'),state);
  await docker(['rm','-f',n],undefined,true);
 }
 await docker(['network','rm',network],undefined,true);
 await docker(['volume','rm',volume],undefined,true);
 const remainingContainers=(await docker(['ps','-a','--filter','label=axi.eval.batch='+batch.id,'--format','{{.Names}}'])).stdout.trim();
 const remainingNetworks=(await docker(['network','ls','--filter','label=axi.eval.batch='+batch.id,'--format','{{.Name}}'])).stdout.trim();
 const remainingVolume=await docker(['volume','inspect',volume],undefined,true);
 assert(!remainingContainers&&!remainingNetworks&&remainingVolume.exitCode!==0&&/No such|not found/i.test(remainingVolume.stderr),'中断资源清理未完成');
 const files:any[]=[];
 function scan(path:string){for(const n of readdirSync(path).sort()){const p=join(path,n),st=lstatSync(p);if(st.isDirectory())scan(p);else if(st.isFile()&&n!=='relay.env')files.push({path:relative(directory,p),bytes:st.size,sha256:sha(readFileSync(p))})}}
 scan(directory);save(join(recovery,'remaining-evidence.json'),{status:'partial-interrupted',files,missing:['normal execution completion is not inferred'],writersStopped:true});
}
save(join(recovery,'result.json'),{complete:true,resources:resourceIdentity,errors,claimConsumed:true,realCliRelaunched:false,normalTraceClaimed:false});
console.log(JSON.stringify({slot:slotId,recovered:true,paused:true,normalTraceClaimed:false}));
