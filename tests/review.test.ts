import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {APIClient} from '../src/api/client.ts';
import {Agent} from '../src/agent/loop.ts';
import {RequestBudgetError,type ReviewMode} from '../src/agent/review.ts';
import {activeSignal,event,streamFixture,tool} from './fixtures.ts';
const done=()=>streamFixture();
const bash=(id:string)=>streamFixture([tool(id,'printf effect')],'tool_use');
const error=()=>event('error',{error:{type:'rate_limit_error',message:'busy'}});
const sse=(wire:string)=>new Response(wire,{headers:{'content-type':'text/event-stream'}});
function setup(reply:(n:number,body:any)=>string|Response,extra:any={}){
 const requests:any[]=[],logs:any[]=[],executed:string[]=[];let approvals=0;
 const record=(kind:string,data:any)=>{logs.push({kind,data});extra.record?.(kind,data)};
 const client=new APIClient({url:'http://localhost/v1/messages',apiKey:'fake-review',model:'claude-opus-5-5',timeoutMs:1000},'',{fetch:(async(_url:any,init:any)=>{const body=JSON.parse(init.body);requests.push(body);const r=reply(requests.length,body);return typeof r==='string'?sse(r):r}) as unknown as typeof fetch,sleep:async()=>{},record});
 const agent=new Agent({cwd:extra.cwd??'/test',record,reviewMode:extra.mode??(()=> 'auto'),call:(history,options)=>client.call(history,options),approve:async()=>{approvals++;return {allowed:extra.allowed??true,reason:'保留原文件'}},execute:async(input)=>{executed.push(input.command);return {content:'退出码：0',isError:false,exitCode:0,outcome:'completed'}},onReviewStart:extra.onReviewStart});
 return {agent,requests,logs,executed,approvals:()=>approvals,ends:()=>logs.filter(x=>x.kind==='task_end').map(x=>x.data)};
}
const opts=()=>({signal:activeSignal(),effort:'medium' as const});

test('一次同会话复核，初稿保留且工具只执行一次，配对后再插入自动请求',async()=>{
 const x=setup(n=>[streamFixture([tool('a','one'),tool('b','two')],'tool_use'),done(),bash('review'),done()][n-1]!);
 await x.agent.run('原任务',opts());
 expect(x.requests).toHaveLength(4);expect(x.executed).toEqual(['one','two','printf effect']);expect(x.approvals()).toBe(3);
 expect(x.requests[2].messages.at(-1).content).toContain('Axi自动收尾复核；不是用户的新指令');
 expect(x.requests[2].messages.slice(0,-2)).toEqual(x.requests[1].messages);
 expect(x.logs.filter(x=>x.kind==='review_start')).toHaveLength(1);expect(x.logs.filter(x=>x.kind==='review_end')).toHaveLength(1);
 expect(x.ends()[0]).toMatchObject({outcome:'completed',reviewed:true,budget:{workRequests:2,reviewRequests:2,requests:4}});
});

test('普通问答、只有拒绝或只有读取不触发复核',async()=>{
 for(const [kind,allowed]of [['plain',true],['denied',false]]as const){const x=setup(n=>kind==='plain'||n===2?done():bash('deny'),{allowed});await x.agent.run('任务',opts());expect(x.ends()[0].reviewed).toBe(false);expect(x.requests.length).toBe(kind==='plain'?1:2);expect(x.executed).toHaveLength(0)}
 const dir=mkdtempSync(join(tmpdir(),'axi-review-read-'));try{writeFileSync(join(dir,'a.txt'),'read-only');const x=setup(n=>n===1?streamFixture([{type:'tool_use',id:'read',name:'read',input:{path:'a.txt'}}],'tool_use'):done(),{cwd:dir});await x.agent.run('读取',opts());expect(x.requests).toHaveLength(2);expect(x.ends()[0].reviewEligible).toBe(false)}finally{rmSync(dir,{recursive:true,force:true})}
});

test('模式在用户回合开始时固定，下一回合重置预算；关闭模式不增加请求',async()=>{
 let mode:ReviewMode='auto';const x=setup(n=>{if(n===1)mode='off';return n===1||n===4?bash('t'+n):done()},{mode:()=>mode});
 await x.agent.run('自动',opts());expect(x.requests).toHaveLength(3);const prior=x.agent.history;
 await x.agent.run('关闭',opts());expect(x.requests).toHaveLength(5);expect(x.agent.history.slice(0,prior.length)).toEqual(prior);
 expect(x.ends().map(e=>[e.reviewed,e.budget.requests])).toEqual([[true,3],[false,2]]);
});

test('40次完整工具响应后在安全点进入工作中复核，最多50次',async()=>{
 const x=setup(n=>n<50?bash('t'+n):done());await x.agent.run('长任务',opts());
 expect(x.requests).toHaveLength(50);expect(x.executed).toHaveLength(49);
 const phase=x.logs.find(x=>x.kind==='review_start').data;expect(phase).toMatchObject({reason:'work_budget',checkpointKind:'work_in_progress',budget:{workRequests:40,reviewRequests:0}});
 const lastWork=x.requests[40].messages.at(-2).content;expect(lastWork[0].tool_use_id).toBe('t40');
 expect(x.ends()[0]).toMatchObject({outcome:'completed',budget:{requests:50,workRequests:40,reviewRequests:10}});
});

test('提前复核也最多10次，耗尽后不再发请求，已有工具结果完整',async()=>{
 const x=setup(n=>n===2?done():bash('t'+n));await expect(x.agent.run('任务',opts())).rejects.toBeInstanceOf(RequestBudgetError);
 expect(x.requests).toHaveLength(12);expect(x.executed).toHaveLength(11);expect(x.ends()[0]).toMatchObject({outcome:'budget_exhausted',budget:{workRequests:2,reviewRequests:10}});
 expect((x.agent.history.at(-1)!.content as any[])[0].tool_use_id).toBe('t12');
});

test('关闭模式达到全任务50次后停止，不能发第51次',async()=>{
 const x=setup(n=>bash('t'+n),{mode:()=> 'off'});expect(await x.agent.run('任务',opts())).toContain('未完成');expect(x.requests).toHaveLength(50);expect(x.ends()[0]).toMatchObject({outcome:'budget_exhausted',reviewed:false,budget:{requests:50}});
});

test('重试计入复核预算，失败响应不写历史，不重做工具',async()=>{
 const x=setup(n=>n===1?bash('once'):n===3?error():done());await x.agent.run('任务',opts());
 expect(x.requests).toHaveLength(4);expect(x.requests[2]).toEqual(x.requests[3]);expect(x.executed).toHaveLength(1);
 expect(x.logs.filter(x=>x.kind==='response')).toHaveLength(3);expect(x.ends()[0].budget).toMatchObject({workRequests:2,reviewRequests:2});
});

test('第40次请求失败时不借复核额度继续，不追加失败响应',async()=>{
 const x=setup(n=>n===40?error():bash('t'+n));await expect(x.agent.run('任务',opts())).rejects.toBeInstanceOf(RequestBudgetError);
 expect(x.requests).toHaveLength(40);expect(x.executed).toHaveLength(39);expect(x.ends()[0].reviewed).toBe(false);expect(x.logs.filter(x=>x.kind==='review_start')).toHaveLength(0);
});

test('复核退避中取消后停止，并允许下个用户回合正常继续',async()=>{
 const ac=new AbortController(),x=setup(n=>n===1?bash('t'):n===3?error():done());
 await expect(x.agent.run('任务',{...opts(),signal:ac.signal,onRetry:()=>ac.abort()})).rejects.toThrow();
 expect(x.requests).toHaveLength(3);expect(x.ends()[0]).toMatchObject({outcome:'interrupted',reviewed:true});
 await x.agent.run('继续',opts());expect(x.requests).toHaveLength(4);expect(x.ends()[1]).toMatchObject({outcome:'completed',reviewed:false,budget:{requests:1}});
});

test('截断、拒绝和协议失败不能当作待复核初稿',async()=>{
 for(const stop of ['max_tokens','refusal']){const x=setup(n=>n===1?bash('t'):streamFixture([],stop));await x.agent.run('任务',opts());expect(x.requests).toHaveLength(2);expect(x.ends()[0]).toMatchObject({outcome:stop==='refusal'?'refused':'truncated',reviewed:false})}
 const x=setup(n=>n===1?bash('t'):'data: invalid\n\n');await expect(x.agent.run('任务',opts())).rejects.toThrow();expect(x.ends()[0]).toMatchObject({outcome:'failed',reviewed:false});
});

test('复核日志失败不再请求或修改，既有副作用保留且不能继续会话',async()=>{
 const x=setup(n=>n===1?bash('t'):done(),{record:(kind:string)=>{if(kind==='review_start')throw Error('broken log')}});
 await expect(x.agent.run('任务',opts())).rejects.toThrow('日志');expect(x.requests).toHaveLength(2);expect(x.executed).toHaveLength(1);await expect(x.agent.run('继续',opts())).rejects.toThrow('日志');
});

test('取消发生在进入复核时，不得额外请求',async()=>{
 const ac=new AbortController(),x=setup(n=>n===1?bash('t'):done(),{onReviewStart:()=>ac.abort()});await expect(x.agent.run('任务',{...opts(),signal:ac.signal})).rejects.toThrow();expect(x.requests).toHaveLength(2);expect(x.ends()[0].outcome).toBe('interrupted');
});
