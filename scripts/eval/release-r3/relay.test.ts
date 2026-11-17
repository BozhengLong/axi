import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyChunks} from './chunks.ts';

const reply = {content:[{type:'text',text:'done'}],stopReason:'end_turn'};
const body = {model:'claude-opus-5-5',output_config:{effort:'medium'},messages:[{role:'user',content:'test'}],stream:true};
async function fixture(action:(x:any)=>Promise<void>) {
  const base=process.env.AXI_TEST_EVIDENCE_DIR??tmpdir();mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'axi-r3-relay-')),admin=crypto.randomUUID(),token=crypto.randomUUID();
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'relay.ts')],{env:{PATH:process.env.PATH,HOME:root,TMPDIR:tmpdir(),EVAL_RELAY_HOST:'127.0.0.1',EVAL_RELAY_PORT:'0',EVAL_MOCK_ONLY:'1',EVAL_EVIDENCE_ROOT:root,EVAL_ADMIN_TOKEN:admin,EVAL_UPSTREAM_URL:'http://127.0.0.1:1/v1/messages',EVAL_UPSTREAM_KEY:'synthetic-r3-key'},stdout:'pipe',stderr:'pipe'});
  const stderr=new Response(child.stderr).text(),reader=child.stdout.getReader();let output='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  try{
    while(!output.includes('\n')){const x=await reader.read();if(x.done)throw Error('relay failed: '+await stderr);output+=new TextDecoder().decode(x.value);}
    const port=JSON.parse(output.split('\n')[0]!).port;
    const http=async(path:string,data:unknown,control=false)=>{
      const p=Bun.spawn(['curl','--noproxy','*','--silent','--show-error','--max-time','5','-X','POST',`http://127.0.0.1:${port}${path}`,'-H','content-type: application/json','-H',control?`authorization: Bearer ${admin}`:`x-api-key: ${token}`,'--data-binary','@-','--write-out','\n%{http_code}'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
      p.stdin.write(JSON.stringify(data));p.stdin.end();const [raw,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(err);
      const at=raw.lastIndexOf('\n');return{status:Number(raw.slice(at+1)),text:raw.slice(0,at)};
    };
    const control=async(action:string,data:any={id:'run'})=>{const r=await http('/control/'+action,data,true);if(r.status!==200)throw Error('control '+action+': '+r.status+' '+r.text);return JSON.parse(r.text)};
    const register=async(mock:any[],ms=15000,executionPolicy:any={version:'r3',limitMode:'unlimited',requestLimit:null,executionDeadline:Date.now()+ms})=>http('/control/register',{id:'run',token,mock,executionPolicy},true);
    const seal=async()=>{await control('revoke');for(let i=0;i<100;i++){if((await control('state')).activeRequests===0)break;await Bun.sleep(5);}await control('close');const dir=join(root,'run.chunks'),manifest=verifyChunks(dir);return Buffer.concat(manifest.chunks.map(c=>readFileSync(join(dir,c.name)))).toString('utf8').trim().split('\n').map(l=>JSON.parse(l));};
    await action({register,control,http,seal,root,port,token});
  }finally{clearTimeout(timer);child.kill('SIGKILL');await child.exited;writeFileSync(join(root,'relay.stderr'),await stderr);writeFileSync(join(root,'relay.stdout'),output);reader.releaseLock();if(!process.env.AXI_TEST_EVIDENCE_DIR)rmSync(root,{recursive:true,force:true});}
}

test('实际R3代理超过50次仍完整转发，原始证据与计数一致',async()=>{
  await fixture(async x=>{
    expect((await x.register(Array.from({length:81},()=>reply))).status).toBe(200);
    for(let i=0;i<81;i++){const r=await x.http('/v1/messages',body);expect(r.status).toBe(200);expect(r.text).toContain('message_stop');}
    const state=await x.control('state');expect(state.responseCount).toBe(81);expect(state.responses).toHaveLength(1);expect(state.meter).toMatchObject({requestLimit:null,receivedGeneration:81,forwardedGeneration:81,blockedGeneration:0});
    const events=await x.seal();expect(events.filter((e:any)=>e.kind==='request')).toHaveLength(81);expect(events.filter((e:any)=>e.kind==='complete_response')).toHaveLength(81);expect(events.at(-1).kind).toBe('writer_closed');expect(events.some((e:any)=>e.kind==='truncated')).toBe(false);
  });
},20000);

test('实际R3代理长请求到截止中断，后续请求被拒绝且能够完整封存',async()=>{
  await fixture(async x=>{
    expect((await x.register([{...reply,delayMs:5000}],150)).status).toBe(200);
    const started=performance.now(),r=await x.http('/v1/messages',body);expect(r.status).toBe(502);expect(performance.now()-started).toBeLessThan(2000);
    expect((await x.http('/v1/messages',body)).status).toBe(400);
    const state=await x.control('state');expect(state.meter.blockedGeneration).toBe(1);expect(state.responseCount).toBe(0);
    const events=await x.seal();expect(events.some((e:any)=>e.kind==='upstream_error'&&e.data.localDeadline===true)).toBe(true);expect(events.filter((e:any)=>e.kind==='complete_response')).toHaveLength(0);
  });
},10000);

test('实际R3代理拒绝省略或伪装成50次的运行策略',async()=>{
  await fixture(async x=>{
    expect((await x.register([reply],1000,{})).status).toBe(400);
    expect((await x.register([reply],1000,{version:'r3',limitMode:'unlimited',requestLimit:50,executionDeadline:Date.now()+1000})).status).toBe(400);
  });
},10000);
