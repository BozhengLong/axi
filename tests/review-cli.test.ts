import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {event,streamFixture} from './fixtures.ts';
const write=(id:string)=>streamFixture([{type:'tool_use',id,name:'write',input:{path:id+'.txt',content:'saved'}}],'tool_use');
const text=(v:string)=>streamFixture([{type:'text',text:v}]);
async function cli(reply:(n:number,body:any)=>string,action:(x:any)=>Promise<void>){
 const cwd=mkdtempSync(join(tmpdir(),'axi-review-cli-')),requests:any[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json();requests.push(body);return new Response(reply(requests.length,body),{headers:{'content-type':'text/event-stream'}})}});
 const env={...process.env};for(const k of Object.keys(env))if(/^(http|https|all|no)_proxy$/i.test(k))delete env[k];
 const child=Bun.spawn([process.execPath,resolve('src/main.ts')],{cwd,env:{...env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_API_KEY:'review-local-fake',NO_COLOR:'1'},stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 let output='',cursor=0;const collect=(async()=>{for await(const c of child.stdout)output+=new TextDecoder().decode(c)})();const stderr=new Response(child.stderr).text();
 const send=async(s:string)=>{child.stdin.write(s+'\n');await child.stdin.flush()};
 const wait=async(s:string)=>{const until=Date.now()+6000;while(Date.now()<until){const at=output.indexOf(s,cursor);if(at>=0){cursor=at+s.length;return}await Bun.sleep(5)}throw Error('未看到'+s+':'+output.slice(-1500))};
 const logs=()=>readFileSync(join(cwd,'.axi/logs',readdirSync(join(cwd,'.axi/logs')).find(s=>s.endsWith('.jsonl'))!),'utf8').trim().split('\n').map(s=>JSON.parse(s));
 try{await wait('你 [medium] > ');await action({cwd,requests,send,wait,logs,child,output:()=>output});await send('/exit');expect(await child.exited).toBe(0);await collect;expect(await stderr).toBe('')}
 finally{child.kill('SIGKILL');await child.exited;server.stop(true);rmSync(cwd,{recursive:true,force:true})}
}

test('真实CLI：默认自动复核、off开关、复核工具仍逐次批准，拒绝不绕过',async()=>{
 await cli((n)=>({1:write('a'),2:text('初稿A'),3:streamFixture([{type:'tool_use',id:'check',name:'bash',input:{command:'cat a.txt'}}],'tool_use'),4:text('最终A'),5:write('b'),6:text('最终B'),7:write('c'),8:text('初稿C'),9:streamFixture([{type:'tool_use',id:'deny',name:'bash',input:{command:'touch denied.txt'}}],'tool_use'),10:text('拒绝已记录')} as Record<number,string>)[n]??text('unexpected'),async x=>{
  await x.send('任务A');await x.wait('应用这次修改？[y/N] ');await x.send('y');await x.wait('Axi：收尾复核');await x.wait('执行这次调用？[y/N] ');expect(x.requests).toHaveLength(3);await x.send('y');await x.wait('最终A');await x.wait('你 [medium] > ');
  expect(x.requests[2].messages.at(-1).content).toContain('Axi自动收尾复核');expect(readFileSync(join(x.cwd,'a.txt'),'utf8')).toBe('saved');
  await x.send('/review off');await x.wait('收尾复核模式：off');await x.wait('你 [medium] > ');await x.send('任务B');await x.wait('应用这次修改？[y/N] ');await x.send('y');await x.wait('最终B');await x.wait('你 [medium] > ');expect(x.requests).toHaveLength(6);
  await x.send('/review auto');await x.wait('收尾复核模式：auto');await x.wait('你 [medium] > ');await x.send('任务C');await x.wait('应用这次修改？[y/N] ');await x.send('y');await x.wait('Axi：收尾复核');await x.wait('执行这次调用？[y/N] ');await x.send('n');await x.wait('拒绝理由（选填，回车跳过）：');await x.send('不要创建文件');await x.wait('拒绝已记录');await x.wait('你 [medium] > ');
  expect(x.requests[9].messages.at(-1).content[0].content).toContain('不要创建文件');const logs=x.logs();expect(logs.filter((e:any)=>e.kind==='review_start')).toHaveLength(2);expect(logs.filter((e:any)=>e.kind==='task_end').map((e:any)=>[e.data.outcome,e.data.budget.requests,e.data.reviewed])).toEqual([['completed',4,true],['completed',2,false],['completed',4,true]]);
 });
},20000);

test('真实CLI：复核退避中Ctrl+C不误报完成，下回合恢复',async()=>{
 await cli(n=>n===1?write('kept'):n===2?text('初稿'):n===3?event('error',{error:{type:'rate_limit_error',message:'busy'}}):text('下一回合'),async x=>{
  await x.send('工作');await x.wait('应用这次修改？[y/N] ');await x.send('y');await x.wait('Axi：收尾复核');await x.wait('将在 1.0s 后重试');x.child.kill('SIGINT');await x.wait('已中止。');await x.wait('你 [medium] > ');expect(x.requests).toHaveLength(3);expect(readFileSync(join(x.cwd,'kept.txt'),'utf8')).toBe('saved');
  expect(x.logs().filter((e:any)=>e.kind==='task_end').at(-1).data.outcome).toBe('interrupted');await x.send('继续');await x.wait('下一回合');await x.wait('你 [medium] > ');expect(x.requests).toHaveLength(4);
 });
},15000);
