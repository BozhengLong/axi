import {statfsSync} from 'node:fs';
import {join} from 'node:path';
import {control,execute,docker,save,type Runtime,type R3Batch} from './core.ts';

export const freeBytes=(path:string)=>{const s=statfsSync(path);return s.bavail*s.bsize;};
const stopCode=(signal:string)=>`import{readdirSync,readFileSync}from'node:fs';for(const p of readdirSync('/proc')){const n=Number(p);if(!n||n===1||n===process.pid)continue;try{if(/^Uid:\\s+1000\\s/m.test(readFileSync('/proc/'+p+'/status','utf8')))process.kill(n,${JSON.stringify(signal)})}catch{}}`;

// 固定映射一次墙钟，避免系统回拨延长窗口。资源错误只保全，不归为任务N。
export function guardRuntime(batch:R3Batch,runtime:Runtime,deadline:number,options:{mockFreeBytes?:()=>number;pollMs?:number}={}){
 if(options.mockFreeBytes&&batch.mode!=='mock')throw Error('真实运行禁止注入磁盘读数');
 const floor=9*1024**3,now=performance.now(),until=now+Math.max(0,deadline-Date.now());
 let closed=false,stopping:Promise<void>|undefined,cause:string|undefined,minimum=Infinity;
 const stop=(reason:string)=>{
  if(stopping)return stopping;cause=reason;
  stopping=(async()=>{
   const startedAt=new Date().toISOString(),started=performance.now();
   // 授权出口与任务中断同时进行；不等待一个失败控制通道再停止进程。
   const revoking=control(batch,'revoke',{id:runtime.id}).then(value=>({ok:true,value}),e=>({ok:false,error:String(e)}));
   const unpause=await docker(['unpause',runtime.name],undefined,true,1000).catch(e=>({error:String(e)}));
   const signal=await execute(runtime,['bun','-e',stopCode('SIGINT')],undefined,true,1000).catch(e=>({error:String(e)}));
   await Bun.sleep(Math.max(0,1000-(performance.now()-started)));
   const killed=await execute(runtime,['bun','-e',stopCode('SIGKILL')],undefined,true,2000).catch(e=>({error:String(e)}));
   const processStoppedMs=performance.now()-started;
   save(join(runtime.directory,'runtime-stop.json'),{reason,startedAt,endedAt:new Date().toISOString(),processStoppedMs,deadline,minimumFreeBytes:minimum,revoking:await revoking,unpause,signal,killed});
  })();return stopping;
 };
 const check=()=>{
  if(closed||stopping)return;
  try{const available=options.mockFreeBytes?.()??freeBytes(batch.study);minimum=Math.min(minimum,available);if(available<floor){void stop('resource');return;}}
  catch{void stop('resource');return;}
  if(performance.now()>=until)void stop('deadline');
 };
 const interval=setInterval(check,options.pollMs??1000),timer=setTimeout(()=>{if(!closed)void stop('deadline');},Math.max(0,until-performance.now()));
 check();
 return{get cause(){return cause;},async finish(){if(closed){await stopping;return;}closed=true;clearInterval(interval);clearTimeout(timer);await stopping;save(join(runtime.directory,'runtime-guard.json'),{deadline,minimumFreeBytes:minimum,floorBytes:floor,cause:cause??null,closed:true});}};
}
