import { expect, test } from 'bun:test';
import { APIClient } from '../src/api/client.ts';
import { MessageAssembler, StreamAPIError } from '../src/api/stream.ts';
import { Agent } from '../src/agent/loop.ts';
import { observeAPIError } from '../scripts/eval/container/api-error.ts';
import { classifyExecution } from '../scripts/eval/c7/outcome.ts';
import { activeSignal, event, streamFixture, tool } from './fixtures.ts';
const limit = "This request would exceed your account's rate limit. Please try again later.";
const config = {url:'http://localhost/v1/messages',apiKey:'secret-test-token',model:'claude-opus-5-5',timeoutMs:1000};
const sse = (wire:string) => new Response(wire,{headers:{'content-type':'text/event-stream'}});
const cases = [
 {raw:{type:'rate_limit_error',message:'busy'},type:'rate_limit_error',format:'structured',rule:'structured-type',retry:true,classification:'environment_indeterminate'},
 {raw:limit,type:'rate_limit_error',format:'string',rule:'gateway-rate-limit-v1',retry:true,classification:'environment_indeterminate'},
 {raw:'unrelated rate limit text',type:'unknown_error',format:'string',rule:'unrecognized',retry:false,classification:'unclassified_failure'},
 {raw:limit+' extra',type:'unknown_error',format:'string',rule:'unrecognized',retry:false,classification:'unclassified_failure'},
 {raw:{type:'authentication_error',message:limit},type:'authentication_error',format:'structured',rule:'structured-type',retry:false,classification:'authentication_failure'},
 {raw:{type:'future_error',message:'future'},type:'future_error',format:'structured',rule:'structured-type',retry:false,classification:'unclassified_failure'},
 {raw:null,type:'unknown_error',format:'malformed',rule:'unrecognized',retry:false,classification:'unclassified_failure'},
 {raw:['rate_limit_error'],type:'unknown_error',format:'malformed',rule:'unrecognized',retry:false,classification:'unclassified_failure'},
 {raw:{type:42,message:{reason:'unrecognized'}},type:'unknown_error',format:'structured',rule:'unrecognized',retry:false,classification:'unclassified_failure'},
];
for (const [i,c] of cases.entries()) test(`错误契约独立预期 ${i}`,async()=>{
 const value={type:'error',error:c.raw};
 const expected={errorType:c.type,format:c.format,rule:c.rule,retryable:c.retry};
 let captured:unknown;
 try {new MessageAssembler().accept({event:'error',data:JSON.stringify(value)});} catch(e){captured=e;}
 expect(captured).toBeInstanceOf(StreamAPIError);
 expect((captured as StreamAPIError).normalized).toMatchObject(expected);
 expect((captured as StreamAPIError).rawError).toEqual(c.raw);
 expect(observeAPIError(value)).toMatchObject(expected);
 expect(classifyExecution('product_error',[{kind:'request',data:{path:'/v1/messages'}},{kind:'response_headers',data:{status:200}},{kind:'sse',data:value}])).toBe(c.classification);
 let calls=0;const logs:any[]=[];const sleeps:number[]=[];
 const client=new APIClient(config,'',{fetch:(async()=>{calls++;return sse(event('error',{error:c.raw}));}) as unknown as typeof fetch,sleep:async ms=>{sleeps.push(ms)},record:(kind,data)=>logs.push({kind,data})});
 await expect(client.call([],{signal:activeSignal(),effort:'medium'})).rejects.toThrow();
 expect(calls).toBe(c.retry?4:1);expect(sleeps).toEqual(c.retry?[1000,2000,4000]:[]);
 const errors=logs.filter(x=>x.kind==='request_error');expect(errors.at(-1).data.willRetry).toBe(false);
 expect(errors[0].data.normalizedError).toMatchObject(expected);expect(errors[0].data.rawError).toEqual(c.raw);
 expect(logs.filter(x=>x.kind==='response')).toHaveLength(0);
});

test('普通正文和工具数据不能触发错误归因；鉴权不会被前次限流遮盖',async()=>{
 const data={type:'content_block_delta',error:limit,delta:{type:'text_delta',text:limit}};
 expect(observeAPIError(data)).toBeUndefined();
 expect(classifyExecution('product_error',[{kind:'request',data:{path:'/v1/messages'}},{kind:'sse',data:{type:'error',error:limit}},{kind:'request',data:{path:'/v1/messages'}},{kind:'response_headers',data:{status:401}}])).toBe('authentication_failure');
 const client=new APIClient(config,'',{fetch:(async()=>sse(streamFixture([{type:'text',text:limit}]))) as unknown as typeof fetch});
 expect((await client.call([],{signal:activeSignal(),effort:'medium'})).content).toEqual([{type:'text',text:limit}]);
});

test('部分工具错误后重试保持请求快照；已执行工具不重做，失败响应不入历史',async()=>{
 const partial=event('message_start',{message:{content:[]}})+event('content_block_start',{index:0,content_block:{type:'tool_use',id:'never',name:'bash',input:{}}})+event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:'{"command":'}})+event('error',{error:limit});
 const wires=[streamFixture([tool('once','side-effect')],'tool_use'),partial,streamFixture()];
 const bodies:string[]=[],logs:any[]=[];let executed=0;
 const client=new APIClient(config,'',{fetch:(async(_url: string | URL | Request,init?: RequestInit)=>{bodies.push(init!.body as string);return sse(wires.shift()!);}) as unknown as typeof fetch,sleep:async()=>{},record:(kind,data)=>logs.push({kind,data})});
 const agent=new Agent({ reviewMode: () => "off",cwd:'/test',call:(history,options)=>client.call(history,options),approve:async()=>({allowed:true}),execute:async()=>{executed++;return {content:'done',isError:false,exitCode:0,outcome:'completed'}}});
 await agent.run('run',{signal:activeSignal(),effort:'medium'});
 expect(executed).toBe(1);expect(bodies).toHaveLength(3);expect(bodies[1]).toBe(bodies[2]);
 expect(agent.history.map(x=>x.role)).toEqual(['user','assistant','user','assistant']);
 expect(JSON.stringify(agent.history)).not.toContain('never');expect(logs.filter(x=>x.kind==='response')).toHaveLength(2);
});

test('字符串限流退避可取消；错误详情脱敏但未知结构不丢失',async()=>{
 const controller=new AbortController();let calls=0;const logs:any[]=[];
 const client=new APIClient(config,'',{fetch:(async()=>{calls++;return sse(event('error',{error:limit}));}) as unknown as typeof fetch,record:(kind,data)=>logs.push({kind,data})});
 await expect(client.call([],{signal:controller.signal,effort:'medium',onRetry:()=>controller.abort()})).rejects.toThrow();
 expect(calls).toBe(1);expect(logs.filter(x=>x.kind==='retry_scheduled')[0].data.delayMs).toBe(1000);
 const unknown={message:'secret-test-token http://localhost/v1/messages',extra:{value:'unrecognized'}};
 const other=new APIClient(config,'',{fetch:(async()=>sse(event('error',{error:unknown}))) as unknown as typeof fetch,record:(kind,data)=>{if(kind==='request_error')logs.push(data)}});
 await expect(other.call([],{signal:activeSignal(),effort:'medium'})).rejects.toThrow('认证信息已隐藏');
 expect(logs.at(-1).rawError.extra.value).toBe('unrecognized');expect(JSON.stringify(logs.at(-1))).not.toContain('secret-test-token');
});

test('畸形JSON停止且不猜测重试；请求历史在退避期间变化不影响快照',async()=>{
 let calls=0;const broken=new APIClient(config,'',{fetch:(async()=>{calls++;return sse('data: {bad}\n\n');}) as unknown as typeof fetch});
 await expect(broken.call([],{signal:activeSignal(),effort:'medium'})).rejects.toThrow('有效 JSON');expect(calls).toBe(1);
 const history=[{role:'user' as const,content:'original'}],bodies:string[]=[];
 const client=new APIClient(config,'',{fetch:(async(_url: string | URL | Request,init?: RequestInit)=>{bodies.push(init!.body as string);return sse(bodies.length===1?event('error',{error:limit}):streamFixture());}) as unknown as typeof fetch,sleep:async()=>{history[0]!.content='changed'}});
 await client.call(history,{signal:activeSignal(),effort:'medium'});expect(bodies[0]).toBe(bodies[1]);expect(JSON.parse(bodies[1]!).messages[0].content).toBe('original');
});
