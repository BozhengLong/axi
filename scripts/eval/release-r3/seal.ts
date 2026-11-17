import {join} from 'node:path';
import {control,docker,save,relayConsole,type Batch,type Runtime} from './core.ts';
import {finalizeTrace,fileHash} from './trace.ts';

export async function sealBatchTraces(batch:Batch,runtimes:Pick<Runtime,'id'|'directory'>[]){
  const states=[];
  for(const runtime of runtimes){
    let state=await control(batch,'state',{id:runtime.id});
    if(!state.revoked)throw Error('封存前必须撤销运行');
    const until=performance.now()+10000;
    while(state.activeRequests&&performance.now()<until){await Bun.sleep(10);state=await control(batch,'state',{id:runtime.id});}
    if(state.activeRequests)throw Error('转发连接尚未收束');
    state=await control(batch,'close',{id:runtime.id});if(!state.closed)throw Error('转发器未关闭记录写入者');states.push(state);
  }
  save(join(batch.directory,'relay-before-close.json'),{at:new Date().toISOString(),states});
  await relayConsole(batch);await docker(['rm','-f',batch.relay]);
  const remaining=(await docker(['ps','-a','--filter',`name=^/${batch.relay}$`,'--format','{{.Names}}'])).stdout.trim();if(remaining)throw Error('转发容器仍存在');
  save(join(batch.directory,'relay-closed.json'),{at:new Date().toISOString(),name:batch.relay,remaining:[]});
  const seals=[];
  for(const runtime of runtimes){
    save(join(runtime.directory,'writers-closed.json'),{relay:batch.relay,product:'frozen and removed',unfinishedRequests:0});
    const manifest=finalizeTrace(batch,runtime as Runtime);
    seals.push({id:runtime.id,files:manifest.files.length,manifestHash:fileHash(join(runtime.directory,'trace-manifest.json'))});
  }
  save(join(batch.directory,'sealed-traces.json'),{at:new Date().toISOString(),seals});return seals;
}
