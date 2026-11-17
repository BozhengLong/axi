import { expect, test } from 'bun:test';
import { APIClient, RetryWindowError } from '../src/api/client.ts';
import { loadConfig } from '../src/config.ts';
import { activeSignal, streamFixture } from './fixtures.ts';
const ok = () => new Response(streamFixture(), {headers:{'content-type':'text/event-stream'}});
const busy = (after?:string) => new Response('busy',{status:429,headers:after===undefined?{}:{'retry-after':after}});
const base = {url:'http://localhost/v1/messages',apiKey:'fake-window-key',model:'fake',timeoutMs:300_000};
const opts = () => ({signal:activeSignal(),effort:'medium' as const});

function fakeWindow(reply:(n:number)=>Response, windowMs=10_000) {
 let time=0,calls=0;const sleeps:number[]=[],logs:any[]=[];
 const client=new APIClient({...base,retryWindowMs:windowMs},'',{now:()=>time,fetch:(async()=>reply(++calls)) as unknown as typeof fetch,sleep:async ms=>{sleeps.push(ms);time+=ms},record:(kind,data)=>logs.push({kind,data})});
 return {client,sleeps,logs,calls:()=>calls,time:()=>time,advance:(ms:number)=>{time+=ms}};
}

test('默认不在第三次重试截断，超过旧次数仍可成功',async()=>{
 const x=fakeWindow(n=>n<=6?busy():ok(),120_000);await x.client.call([],opts());
 expect(x.calls()).toBe(7);expect(x.sleeps).toEqual([1000,2000,4000,8000,16000,30000]);
 expect(x.logs.filter(x=>x.kind==='response')).toHaveLength(1);
});

test('连续429到窗口截止，不再发出请求，记录独立超限原因',async()=>{
 const x=fakeWindow(()=>busy());await expect(x.client.call([],opts())).rejects.toBeInstanceOf(RetryWindowError);
 expect(x.calls()).toBe(4);expect(x.sleeps).toEqual([1000,2000,4000,3000]);expect(x.time()).toBe(10_000);
 expect(x.logs.filter(x=>x.kind==='retry_exhausted')).toHaveLength(1);
 expect(x.logs.at(-1).data).toMatchObject({attempts:4,windowMs:10_000,elapsedMs:10_000});
 expect(x.logs.filter(x=>x.kind==='response')).toHaveLength(0);
});

test('成功后下一次逻辑调用获得独立窗口，不累积整项任务故障时间',async()=>{
 const x=fakeWindow(n=>n%3===0?ok():busy(),4000);
 await x.client.call([],opts());await x.client.call([],opts());
 expect(x.calls()).toBe(6);expect(x.time()).toBe(6000);
 const requests=x.logs.filter(x=>x.kind==='request');expect(requests[0].data.callId).not.toBe(requests[3].data.callId);expect(requests[3].data.recovery.remainingMs).toBe(4000);
});

test('长Retry-After不能提前重试，也不能超出故障窗口；极大值不会溢出',async()=>{
 for(const after of ['30','1e308']){
  const x=fakeWindow(()=>busy(after),1500);await expect(x.client.call([],opts())).rejects.toBeInstanceOf(RetryWindowError);
  expect(x.calls()).toBe(1);expect(x.sleeps).toEqual([1500]);expect(x.logs.find(x=>x.kind==='retry_scheduled').data.willRetry).toBe(false);
 }
 const x=fakeWindow(n=>n===1?busy('0'):ok(),100);await x.client.call([],opts());expect(x.sleeps).toEqual([1]);
});

test('已到截止的成功响应不作为完成，并关闭响应体',async()=>{
 let time=0,cancelled=false;const logs:any[]=[];
 const client=new APIClient({...base,retryWindowMs:10},'',{now:()=>time,fetch:(async()=>{time=11;return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}})}) as unknown as typeof fetch,record:(kind,data)=>logs.push({kind,data})});
 await expect(client.call([],opts())).rejects.toBeInstanceOf(RetryWindowError);expect(cancelled).toBe(true);expect(logs.filter(x=>x.kind==='response')).toHaveLength(0);
});

test('截止后不再发送，取消优先于窗口到期',async()=>{
 const ac=new AbortController();let calls=0,time=0;
 const client=new APIClient({...base,retryWindowMs:100},'',{now:()=>time,fetch:(async()=>{calls++;return busy()}) as unknown as typeof fetch,sleep:async()=>{time=100;ac.abort()}});
 await expect(client.call([],{...opts(),signal:ac.signal})).rejects.toMatchObject({name:'AbortError'});expect(calls).toBe(1);
});

test('真实请求超时受较短恢复窗口限制',async()=>{
 let calls=0;const started=performance.now();
 const client=new APIClient({...base,retryWindowMs:30},'',{fetch:(async(_url: string | URL | Request,init?: RequestInit)=>new Promise<Response>((_resolve,reject)=>{calls++;init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true})})) as unknown as typeof fetch});
 await expect(client.call([],opts())).rejects.toBeInstanceOf(RetryWindowError);expect(calls).toBe(1);expect(performance.now()-started).toBeLessThan(1000);
});

test('日志失败不能误认网络错误继续重试',async()=>{
 let calls=0,sleeps=0;const client=new APIClient(base,'',{fetch:(async()=>{calls++;return ok()}) as unknown as typeof fetch,sleep:async()=>{sleeps++},record:()=>{throw new TypeError('failed log')}});
 await expect(client.call([],opts())).rejects.toThrow('日志写入失败');expect(calls).toBe(0);expect(sleeps).toBe(0);
});

test('故障窗口配置默认10分钟，拒绝无效值',()=>{
 const env={ANTHROPIC_BASE_URL:'http://localhost',ANTHROPIC_API_KEY:'fake'};
 expect(loadConfig(env).retryWindowMs).toBe(600_000);expect(loadConfig({...env,AXI_RETRY_WINDOW_MS:'45000'}).retryWindowMs).toBe(45000);
 for(const v of ['0','-1','NaN','Infinity','1.5','2147483648',''])expect(()=>loadConfig({...env,AXI_RETRY_WINDOW_MS:v})).toThrow('AXI_RETRY_WINDOW_MS');
});
