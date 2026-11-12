import{readFileSync,writeFileSync,lstatSync,existsSync}from'node:fs';
import{join,resolve,relative,dirname}from'node:path';
import{type Batch}from'../core.ts';
import{job}from'../v1/job.ts';
import{clean,snapshotHash}from'../v1/tasks.ts';
import{type TaskId,type Variant}from'../v1/settings.ts';
import{digest,digestBytes}from'./profile.ts';
import{read}from'./config.ts';
export function exclusive(path:string,data:unknown){writeFileSync(path,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o400})}
function within(run:string,p:string){const f=resolve(run,p),batch=dirname(run);if(!f.startsWith(batch+'/')||/private-state\.json|relay\.env/.test(f)||lstatSync(f).isSymbolicLink()||!lstatSync(f).isFile())throw Error('无效证据路径:'+p);return f}
export function sealExecution(run:string,executionProfileHash:string){
 const trace=read(join(run,'trace-manifest.json'));if(trace.status!=='complete_observable'||trace.missing.length)throw Error('执行Trace不完整');
 const required=['input.json','execution.json','initial-files.json','final-files.json','initial-git.json','final-git.json','result.json','trace-manifest.json'];
 if(existsSync(join(run,'delivery-files.json')))required.push('delivery-files.json');
 const paths=[...new Set([...required,...trace.files.map((x:any)=>x.path)])].sort();
 const hashes=Object.fromEntries(paths.map(p=>[p,digestBytes(readFileSync(within(run,p)))]));
 for(const f of trace.files){const actual=new Bun.CryptoHasher('sha256').update(readFileSync(within(run,f.path))).digest('hex');if(actual!==f.sha256)throw Error('Trace校验失败:'+f.path)}
 const row=read(join(run,'result.json')),initial=read(join(run,'initial-files.json')),final=read(join(run,'final-files.json'));let changedAfterDelivery:string[]=[];
 if(row.status==='completed'){
  const delivery=clean(read(join(run,'delivery-files.json'))),end=clean(final);changedAfterDelivery=Object.keys({...delivery,...end}).filter(p=>JSON.stringify(delivery[p])!==JSON.stringify(end[p]));
  if(changedAfterDelivery.length)throw Error('交付后文件仍有改变:'+changedAfterDelivery.join(','));
 }
 const body={version:1,id:row.id,task:row.task,variant:row.variant,repeat:row.repeat,executionProfileHash,executionStatus:row.status,classification:row.classification,inputSha256:snapshotHash(initial),finalSourceSha256:snapshotHash(final),initialCommit:row.initialCommit,changedAfterDelivery,files:hashes};
 const seal={...body,artifactHash:digest(body)};exclusive(join(run,'execution-seal.json'),seal);return seal;
}
export function verifyExecution(run:string,expectedProfile?:string){
 const seal=read(join(run,'execution-seal.json')), {artifactHash,...body}=seal;
 if(digest(body)!==artifactHash||expectedProfile&&seal.executionProfileHash!==expectedProfile)throw Error('执行清单或profile改变');
 for(const[p,h]of Object.entries(seal.files))if(digestBytes(readFileSync(within(run,p)))!==h)throw Error('执行证据被改变:'+p);
 return seal;
}
export async function executeCandidate(batch:Batch,task:TaskId,variant:Variant,repeat:number,id:string,executionProfileHash:string,options:{mock?:unknown[];maxMs?:number;deadline?:number}={}){
 const row=await job(batch,task,variant,repeat,id,{...options,grade:false,freezeBeforeFinal:true});
 const seal=sealExecution(join(batch.directory,id),executionProfileHash);
 return {id,task,agent:variant==='claude'?'claude':'axi',variant,repeat,runDirectory:join(batch.directory,id),executionStatus:row.status,classification:row.classification,artifactHash:seal.artifactHash,initialCommit:row.initialCommit,activeMs:row.activeMs,wallMs:row.wallMs,forwardedGenerationRequests:row.forwardedGenerationRequests};
}
