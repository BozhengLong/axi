import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {command,save,type Runtime,type R3Batch} from './core.ts';

export async function startGuardian(batch:R3Batch,runtime:Runtime,deadline:number,options:{mockLowSpaceAfterMs?:number}={}){
 if(options.mockLowSpaceAfterMs!==undefined&&(batch.mode!=='mock'||!Number.isFinite(options.mockLowSpaceAfterMs)||options.mockLowSpaceAfterMs<0))throw Error('低空间注入只允许明确模拟模式');
 const parent=await command(['ps','-p',String(process.pid),'-o','lstart=,command=']);
 const config=join(runtime.directory,'guardian-config.json');
 save(config,{parentPid:process.pid,parentIdentity:parent.stdout,deadline,batch:batch.id,study:batch.study,directory:runtime.directory,container:runtime.name,runId:runtime.id,endpoint:batch.endpoint,admin:batch.admin,mode:batch.mode,...(options.mockLowSpaceAfterMs!==undefined?{mockLowSpaceAt:Date.now()+options.mockLowSpaceAfterMs}:{})});
 const child=Bun.spawn(['python3','-B',join(import.meta.dir,'guardian.py'),config],{stdin:'ignore',stdout:Bun.file(join(runtime.directory,'guardian.stdout')),stderr:Bun.file(join(runtime.directory,'guardian.stderr'))});
 const until=performance.now()+10000;
 while(!existsSync(join(runtime.directory,'guardian-ready.json'))){if(child.exitCode!==null||performance.now()>until)throw Error('独立保全监督器未就绪');await Bun.sleep(20);}
 let finished=false;
 return{get cause():string|undefined{const p=join(runtime.directory,'guardian-trigger.json');return existsSync(p)?JSON.parse(readFileSync(p,'utf8')).reason:undefined;},async finish(){
  if(finished)return;save(join(runtime.directory,'guardian-stop-request.json'),{action:'finish',batch:batch.id});
  await Promise.race([child.exited,Bun.sleep(10000)]);
  if(child.exitCode===null||child.exitCode!==0||!existsSync(join(runtime.directory,'guardian-result.json')))throw Error('独立保全监督器未完成，不能封存');
  finished=true;
 }};
}
