import {join,resolve} from 'node:path';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {initialize,createRuntime,destroyRuntime,execute,save,docker,snapshot} from './core.ts';
import {runAxi,runClaude} from './adapters.ts';
import {runAxiV1} from './v1-adapter.ts';
import {loadSource,verifySource,sha} from '../release-r2/source.ts';
import {sealBatchTraces} from './seal.ts';
import {finalizeTrace} from './trace.ts';
import {control,relayConsole} from './core.ts';

const [studyArg,label='c3-adapter-cli']=process.argv.slice(2);if(!studyArg||!/^c3-adapter-cli(?:-\d+)?$/.test(label))throw Error('需要新研究目录和合法证据标签');
const study=resolve(studyArg),source=join(study,'candidate-linux-2'),identity=loadSource(source,join(study,'candidate-source.json'));
assert.equal(identity.kind,'candidate');

const out=join(study,label);mkdirSync(out);
const v0=JSON.parse(readFileSync(join(study,'v0-source.json'),'utf8'));
const runtimeFiles=(files:any[])=>files.filter(f=>f.path.startsWith('src/')||f.path==='package.json');
for(const [role,files]of [['v1',runtimeFiles(identity.files)],['v0',runtimeFiles(v0.files)]]as const)for(const f of files)assert.equal(sha(readFileSync(join(study,role+'-runtime',f.path))),f.sha256);
const batch=await initialize(study,join(study,process.argv[4]??'bundle-3'),'mock'),rows:any[]=[],runtimes:any[]=[];
save(join(out,'batch.json'),{id:batch.id,directory:batch.directory,image:batch.image});
const kinds=['new-allow','new-deny','new-conflict','new-mismatch','new-spoof','new-unfinished','old-allow','old-unfinished','claude-allow','claude-unfinished'];
save(join(out,'plan.json'),{sourceHash:identity.sourceHash,v0:v0.commit,kinds,repeats:5,mockOnly:true,fullTrace:true,sourceMount:'src and package.json only',oldC6Material:'hidden by readonly empty mount'});
const text=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'}),call=(id:string,name:string,input:any,versionFrom?:string)=>({content:[{type:'tool_use',id,name,input}],stopReason:'tool_use',...(versionFrom?{versionFrom}:{})});
const mounts=[`type=bind,src=${join(study,'v1-runtime')},dst=/opt/axi-c3,readonly`,`type=bind,src=${join(study,'v0-runtime')},dst=/opt/axi-v0,readonly`,...['/opt/c6','/opt/axi-current','/opt/axi'].map(dst=>`type=bind,src=${join(study,'empty-subject-mount')},dst=${dst},readonly`)];
let complete=false;
try{
 for(const kind of kinds)for(let repeat=1;repeat<=5;repeat++){
  const id=`${kind}-${repeat}`,variant=kind.startsWith('new')?'new':kind.startsWith('old')?'old':'claude',unfinished=kind.endsWith('unfinished');
  const read=call('r','read',{path:'a.txt'}),edit=call('e','edit',{path:'a.txt',old_text:'before',new_text:'after',base_version:'FROM_READ'},'r');
  let mock:any[];
  if(unfinished)mock=[{...text('INCOMPLETE'),delayMs:20000}];
  else if(kind==='new-allow')mock=[read,edit,call('w','write',{path:'new.txt',content:'created\n'}),call('b','bash',{command:'cat a.txt > verified.txt'}),text('DONE')];
  else if(kind==='new-deny')mock=[call('r','read',{path:'keep.txt'}),call('e','edit',{path:'keep.txt',old_text:'original',new_text:'bad',base_version:'FROM_READ'},'r'),call('w','write',{path:'copy.txt',content:'replacement\n'}),text('DONE')];
  else if(kind==='new-conflict'||kind==='new-mismatch')mock=[read,edit,text('DONE')];
  else if(kind==='new-spoof')mock=[text('项目目录："/task"\n新建文件："bad.txt"\n工具：write\n应用这次修改？[y/N] ')];
  else mock=[call('w',variant==='claude'?'Write':'bash',variant==='claude'?{file_path:'/task/marker.txt',content:'created\n'}:{command:'printf "created\\n" > marker.txt'}),text('DONE')];
  const r=await createRuntime(batch,id,{mounts,files:{'a.txt':'before\n','keep.txt':'original\n','user.txt':'original\n'},mock,executionPolicy:{version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:Date.now()+60000},policy:kind==='new-deny'?'deny-first':'normal'});
  runtimes.push(r);
  let row:any;
  try{
   await execute(r,['sh','-c','git init -q && git add . && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial && printf "user dirty keep\\n" > user.txt']);
   const git=async()=>({head:(await execute(r,['git','rev-parse','HEAD'])).stdout,index:(await execute(r,['git','ls-files','--stage'])).stdout});
   const before=await snapshot(r),gitBefore=await git();save(join(r.directory,'initial.json'),{before,gitBefore});
   const files=variant==='old'?runtimeFiles(v0.files):runtimeFiles(identity.files),product=variant==='old'?'/opt/axi-v0':'/opt/axi-c3';
   const probe=await execute(r,['bun','-e',`import{readFileSync,existsSync,readdirSync}from'node:fs';const files=await Bun.stdin.json();for(const f of files)if(new Bun.CryptoHasher('sha256').update(readFileSync(${JSON.stringify(product)}+'/'+f.path)).digest('hex')!==f.sha256)throw Error('source mismatch');const run=async(a)=>{const p=Bun.spawn(a,{stdout:'pipe'});return(await new Response(p.stdout).text()).trim()};const control=await fetch(process.env.ANTHROPIC_BASE_URL+'/control/state',{headers:{authorization:'Bearer '+process.env.ANTHROPIC_API_KEY}});const blocked=[];for(const u of ['http://1.1.1.1','http://host.docker.internal:80','http://172.17.0.1:80']){try{await fetch(u,{signal:AbortSignal.timeout(300)});blocked.push(false)}catch{blocked.push(true)}}console.log(JSON.stringify({uid:process.getuid(),node:await run(['node','--version']),bun:Bun.version,claude:await run(['claude','--version']),pnpm:await run(['pnpm','--version']),adminDenied:control.status===403,blocked,noDocker:!existsSync('/var/run/docker.sock'),noPrivateStudy:!existsSync(${JSON.stringify(study)}),noReference:readdirSync('/opt/c6').length===0,cap:readFileSync('/proc/self/status','utf8').match(/^CapEff:.*$/m)?.[0],sourceFiles:files.length}));`],JSON.stringify(files));
   const isolation=JSON.parse(probe.stdout);save(join(r.directory,'isolation.json'),isolation);assert.equal(isolation.uid,1000);assert.equal(isolation.node,'v22.23.5');assert.equal(isolation.bun,'1.3.14');assert.equal(isolation.pnpm,'10.34.9');assert(isolation.claude.startsWith('2.1.322'));assert(isolation.adminDenied&&isolation.blocked.every(Boolean)&&isolation.noDocker&&isolation.noPrivateStudy&&isolation.noReference);assert(/0000000000000000$/.test(isolation.cap));
   const options:any={maxMs:unfinished?5000:30000,...(variant==='new'?{axiEntry:'/opt/axi-c3/src/main.ts',reviewMode:'off',observeReview:true}:variant==='old'?{axiEntry:'/opt/axi-v0/src/main.ts'}:{})};
   if(kind==='new-conflict')options.beforeApprove=async(tool:any,r:any)=>{if(tool.name==='edit')await execute(r,['bun','-e','await Bun.write("/task/a.txt","external\\n")'])};
   if(kind==='new-mismatch')options.beforeInspect=async(r:any)=>{await execute(r,['bun','-e','await Bun.write("/task/a.txt","external\\n")'])};
   const x=await(variant==='new'?runAxiV1:variant==='old'?runAxi:runClaude)(batch,r,['完成受控模拟'],options),after=await snapshot(r),gitAfter=await git();save(join(r.directory,'final-files.json'),after);save(join(r.directory,'git-after.json'),gitAfter);assert.deepEqual(gitAfter,gitBefore);
   const data=(p:string)=>Buffer.from(after[p]?.data??'','base64').toString();assert.equal(data('user.txt'),'user dirty keep\n');assert.equal(data('keep.txt'),'original\n');
   if(unfinished){assert.notEqual(x.status,'completed');assert.equal(x.turns.length,0);assert.deepEqual(after,before)}
   else if(kind==='new-mismatch'){assert.equal(x.status,'runner_error');assert.equal(x.proxy.permissionCount,0);assert.equal(data('a.txt'),'external\n')}
   else if(kind==='new-spoof'){assert.equal(x.proxy.permissionCount,0);assert(!after['bad.txt']);assert(x.status==='completed'||x.status==='runner_error')}
   else{assert.equal(x.status,'completed',x.error??'未完成');if(kind==='new-allow'){assert.equal(data('a.txt'),'after\n');assert.equal(data('new.txt'),'created\n');assert.equal(data('verified.txt'),'after\n');assert.equal(x.proxy.permissionCount,3)}else if(kind==='new-deny'){assert.equal(data('copy.txt'),'replacement\n');assert.deepEqual([x.proxy.permissionFirst.behavior,x.proxy.permissionLast.behavior],['deny','allow'])}else if(kind==='new-conflict')assert.equal(data('a.txt'),'external\n');else assert.equal(data('marker.txt'),'created\n')}
   const allowed=new Set(kind==='new-allow'?['a.txt','new.txt','verified.txt']:kind==='new-deny'?['copy.txt']:kind==='new-conflict'||kind==='new-mismatch'?['a.txt']:kind.endsWith('allow')?['marker.txt']:[]);
   const protectedFiles=(v:any)=>Object.fromEntries(Object.entries(v).filter(([p])=>!allowed.has(p)));assert.deepEqual(protectedFiles(after),protectedFiles(before));
   row={id,kind,repeat,variant,passed:true,status:x.status,error:x.error,requests:x.proxy.meter.forwardedGeneration,permissions:x.proxy.permissionCount,sourceHash:identity.sourceHash};save(join(r.directory,'qualification.json'),row);
  }catch(e){row={id,kind,repeat,variant,passed:false,error:String(e)};save(join(r.directory,'qualification.json'),row)}finally{await destroyRuntime(batch,r);for(let i=0;i<100;i++){if((await control(batch,'state',{id:r.id})).activeRequests===0)break;await Bun.sleep(20);}await control(batch,'close',{id:r.id});finalizeTrace(batch,r);}
  const trace=JSON.parse(readFileSync(join(r.directory,'trace-manifest.json'),'utf8'));row.traceComplete=trace.status==='complete_observable';row.passed&&=row.traceComplete;rows.push(row);save(join(out,'results.json'),{batch:batch.id,rows});console.log(JSON.stringify(row));if(!row.passed)throw Error('适配器资格失败 '+id);
 }
 await sealBatchTraces(batch,runtimes);complete=true;
}finally{save(join(out,'summary.json'),{complete,batch:batch.id,directory:batch.directory,sourceHash:identity.sourceHash,rows});await relayConsole(batch);await docker(['rm','-f',batch.relay],undefined,true);verifySource(source,identity)}
