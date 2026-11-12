import {join} from 'node:path';
import {docker,execute,save} from '../core.ts';

// 在销毁评分容器前采集现场。读取失败也单列，不覆盖原评分错误。
export async function gradeDiagnostics(name:string,directory:string){
 const checks=await Promise.allSettled([
  docker(['inspect',name,'--format','{{json .State}}'],undefined,true,3000),
  docker(['top',name,'-eo','pid,ppid,stat,etimes,args'],undefined,true,3000),
  execute({name},['cat','/sys/fs/cgroup/memory.events'],undefined,true,3000),
 ]);
 const data={time:new Date().toISOString(),container:name,checks:checks.map((r,i)=>({kind:['state','processes','memoryEvents'][i],...(r.status==='fulfilled'?{result:r.value}:{error:String(r.reason)})}))};
 save(join(directory,'diagnostics.json'),data);return data;
}
