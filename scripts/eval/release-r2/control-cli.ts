import {mkdtempSync,realpathSync,writeFileSync,readFileSync,readdirSync,rmSync,mkdirSync,cpSync,lstatSync}from'node:fs';
import {join,resolve}from'node:path';
import {tmpdir}from'node:os';
import assert from'node:assert/strict';
import {loadSource,verifySource}from'./source.ts';

const [candidateArg,manifestArg,outArg,platform]=process.argv.slice(2);if(!candidateArg||!manifestArg||!outArg||!platform)throw Error('需要候选、清单、证据、平台');
const candidate=resolve(candidateArg),out=resolve(outArg),identity=loadSource(candidate,manifestArg);assert.equal(identity.kind,'candidate');mkdirSync(out);
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const {event,streamFixture}=await import(join(candidate,'tests/fixtures.ts'));
const cases=['input','stream','retry','review-retry'];save(join(out,'plan.json'),{candidate:identity.commit,sourceHash:identity.sourceHash,platform,cases,repeats:5,boundaries:'observed terminal or received SSE; no random cancellation timing',realModel:false});const rows:any[]=[];
runs:for(const kind of cases)for(let repeat=1;repeat<=5;repeat++){
 const id=`${kind}-${repeat}`,evidence=join(out,id);mkdirSync(evidence);const root=realpathSync(mkdtempSync(join(tmpdir(),'axi-c2-control-')));
 const git=(args:string[])=>{const p=Bun.spawnSync(['git','-C',root,...args]);assert.equal(p.exitCode,0,p.stderr.toString());return p.stdout.toString()};
 writeFileSync(join(root,'user.txt'),'original\n');git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial']);writeFileSync(join(root,'user.txt'),'user dirty\n');
 const snapshot=()=>({files:readdirSync(root).filter(x=>!['.git','.axi'].includes(x)).sort().map(path=>({path,mode:lstatSync(join(root,path)).mode,data:readFileSync(join(root,path)).toString('base64')})),head:git(['rev-parse','HEAD']),index:git(['ls-files','--stage'])});
 const before=snapshot(),http:any[]=[],timeline:any[]=[];save(join(evidence,'before.json'),before);let screen='',cursor=0,phase='base',step=0,error:string|undefined,exitCode:number|undefined,streamController:ReadableStreamDefaultController<Uint8Array>|undefined;
 const baseBlocks=[{type:'thinking',thinking:'先保留用户工作。',signature:'synthetic-signature'},{type:'text',text:'BASE_DONE'}];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const body=await req.json(),n=step++;let wire:string,status=200,headers:any={'content-type':'text/event-stream'};
  if(phase==='base')wire=streamFixture(baseBlocks);
  else if(phase==='continue')wire=streamFixture([{type:'text',text:'CONTINUE_DONE'}]);
  else if(kind==='review-retry'&&n===0)wire=streamFixture([{type:'tool_use',id:'kept',name:'write',input:{path:'kept.txt',content:'saved'}}],'tool_use');
  else if(kind==='review-retry'&&n===1)wire=streamFixture([{type:'text',text:'WORK_DONE'}]);
  else if(kind==='stream'){
   wire=event('message_start',{message:{role:'assistant',content:[],usage:{input_tokens:1,output_tokens:1}}})+event('content_block_start',{index:0,content_block:{type:'text',text:''}})+event('content_block_delta',{index:0,delta:{type:'text_delta',text:'PARTIAL_MUST_NOT_ENTER_HISTORY'}});
   http.push({phase,request:body,response:wire,complete:false});const bodyStream=new ReadableStream<Uint8Array>({start(c){streamController=c;c.enqueue(new TextEncoder().encode(wire))},cancel(){timeline.push({kind:'server-stream-cancelled',at:new Date().toISOString()})}});return new Response(bodyStream,{headers});
  }else{wire=JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'synthetic retry barrier'}});status=429;headers={'content-type':'application/json','retry-after':'30'}}
  http.push({phase,request:body,response:wire,status,complete:true});return new Response(wire,{status,headers});
 }});
 const child=Bun.spawn([process.execPath,join(candidate,'src/main.ts')],{cwd:root,env:{PATH:process.env.PATH,HOME:root,TMPDIR:tmpdir(),LANG:'en_US.UTF-8',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_API_KEY:'synthetic-local-key',NO_COLOR:'1',TERM:'xterm-256color'},terminal:{cols:160,rows:40,data(_t,b){screen+=new TextDecoder().decode(b);timeline.push({kind:'output',at:new Date().toISOString(),base64:Buffer.from(b).toString('base64')})}}});
 const term=child.terminal!,clean=()=>screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replaceAll('\r','');
 const send=(s:string)=>{timeline.push({kind:'input',at:new Date().toISOString(),text:s});term.write(s+'\n')};
 const wait=async(s:string)=>{const end=Date.now()+8000;while(Date.now()<end){const i=clean().indexOf(s,cursor);if(i>=0){cursor=i+s.length;return}await Bun.sleep(5)}throw Error('未看到 '+s)};
 const prompt=()=>wait('你 [medium] > ');
 try{
  await prompt();send('base');await wait('BASE_DONE');await prompt();phase='interrupt';step=0;
  if(kind==='input')term.write('discarded input');else{send('interrupt');if(kind==='stream')await wait('PARTIAL_MUST_NOT_ENTER_HISTORY');else if(kind==='review-retry'){await wait('应用这次修改？[y/N] ');send('y');await wait('Axi：收尾复核');await wait('将在 30.0s 后重试')}else await wait('将在 30.0s 后重试')}
  const beforeCancelRequests=http.length;timeline.push({kind:'cancel-barrier',at:new Date().toISOString(),requests:beforeCancelRequests});term.write('\x03');await wait('已中止。');await prompt();assert.equal(http.length,beforeCancelRequests);try{streamController?.close()}catch{}
  const stopped=snapshot();save(join(evidence,'after-cancel.json'),stopped);assert.equal(stopped.head,before.head);assert.equal(stopped.index,before.index);assert.deepEqual(stopped.files.filter(x=>x.path!=='kept.txt'),before.files);if(kind==='review-retry')assert.equal(readFileSync(join(root,'kept.txt'),'utf8'),'saved');else assert.deepEqual(stopped,before);
  phase='continue';step=0;send('continue');await wait('CONTINUE_DONE');await prompt();send('/exit');const timeout=setTimeout(()=>child.kill('SIGKILL'),8000);exitCode=await child.exited;clearTimeout(timeout);assert.equal(exitCode,0);assert.deepEqual(snapshot(),stopped);
  const request:any=http.at(-1).request;assert.deepEqual(request.messages.slice(0,2),[{role:'user',content:'base'},{role:'assistant',content:baseBlocks}]);assert(!JSON.stringify(request.messages).includes('PARTIAL_MUST_NOT_ENTER_HISTORY'));assert(!JSON.stringify(request.messages).includes('discarded input'));assert.equal(http.filter(x=>x.phase==='interrupt').length,kind==='input'?0:kind==='review-retry'?3:1);
  const logs=join(root,'.axi/logs'),names=readdirSync(logs).filter(p=>p.endsWith('.jsonl'));assert.equal(names.length,1);const events=readFileSync(join(logs,names[0]!),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.deepEqual(events.filter(e=>e.kind==='request').map(e=>e.data.body),http.map(h=>h.request));const ends=events.filter(e=>e.kind==='task_end');assert.deepEqual(ends.map(e=>e.data.outcome),kind==='input'?['completed','completed']:['completed','interrupted','completed']);if(kind!=='input')assert(events.some(e=>e.kind==='cancel_requested'));if(kind==='retry'||kind==='review-retry')assert.equal(events.filter(e=>e.kind==='retry_scheduled').length,1);save(join(evidence,'audit.json'),{ends,requests:http.length,historyPreserved:true,protected:true});
 }catch(e){error=String(e)}finally{child.kill('SIGKILL');await child.exited;term.close();try{streamController?.close()}catch{}server.stop(true);writeFileSync(join(evidence,'terminal.raw'),screen);save(join(evidence,'http.json'),http);save(join(evidence,'timeline.json'),timeline);save(join(evidence,'after.json'),snapshot());cpSync(join(root,'.axi'),join(evidence,'native-axi'),{recursive:true});rmSync(root,{recursive:true,force:true})}
 const row={id,kind,repeat,passed:!error&&exitCode===0,error,exitCode,requests:http.length};rows.push(row);save(join(out,'results.json'),{sourceHash:identity.sourceHash,rows});console.log(JSON.stringify(row));if(!row.passed){process.exitCode=1;break runs}
}
verifySource(candidate,identity);
