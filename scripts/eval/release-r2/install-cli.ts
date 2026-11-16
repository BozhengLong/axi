import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,cpSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {loadSource,verifySource,sha} from './source.ts';

// 从已按README干净安装的C复制两种启动位置。只用合成API，不加载宿主凭据。
const [sourceArg,manifestArg,outArg,platform]=process.argv.slice(2);
if(!sourceArg||!manifestArg||!outArg||!platform)throw Error('需要候选、清单、新证据目录、平台');
const source=resolve(sourceArg),out=resolve(outArg),identity=loadSource(source,manifestArg);
assert.equal(identity.kind,'candidate');assert.equal(process.platform,platform==='macos'?'darwin':'linux');mkdirSync(out);
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
save(join(out,'plan.json'),{identity,platform,repeats:5,locations:['checkout','ordinary-project'],scenarios:['multi-file+verification+auto-review','conflict+denial+bash-denial','strict-read','cancel-confirmation-queue','continue+bounded-read'],realModel:false});
const {streamFixture}=await import(join(source,'tests/fixtures.ts'));
const tool=(id:string,name:string,input:any)=>({type:'tool_use',id,name,input});
const rows:any[]=[];
runs: for(const location of ['checkout','ordinary-project'])for(let repeat=1;repeat<=5;repeat++){
 const id=`${location}-${repeat}`,evidence=join(out,id);mkdirSync(evidence);
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'axi-c2-install-'))),root=join(parent,'project');
 if(location==='checkout')cpSync(source,root,{recursive:true});else mkdirSync(root);
 const demo=location==='checkout'?'release-demo/':'';if(demo)mkdirSync(join(root,demo));
 const path=(name:string)=>demo+name;
 writeFileSync(join(root,path('a.txt')),'before\n');writeFileSync(join(root,path('user.txt')),'original\n');
 writeFileSync(join(root,path('large.txt')),'needle line\n'.repeat(260));
 writeFileSync(join(root,path('verify.cjs')),`const fs=require('fs');if(fs.readFileSync(${JSON.stringify(path('a.txt'))},'utf8')!=='after\\n'||fs.readFileSync(${JSON.stringify(path('helper.txt'))},'utf8')!=='helper\\n')process.exit(1);console.log('VERIFIED');\n`);
 const git=(args:string[])=>{const r=Bun.spawnSync(['git','-C',root,...args]);assert.equal(r.exitCode,0,r.stderr.toString());return r.stdout.toString()};
 if(location!=='checkout'){git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial'])}
 writeFileSync(join(root,path('user.txt')),'user dirty keep\n');
 const snapshot=()=>{const files:any[]=[];const walk=(d:string)=>{for(const name of readdirSync(d).sort()){if(['.git','.axi','node_modules'].includes(name))continue;const p=join(d,name),s=lstatSync(p);if(s.isDirectory())walk(p);else files.push({path:p.slice(root.length+1),mode:s.mode,...(s.isFile()?{data:readFileSync(p).toString('base64')}:{special:true})})}};walk(root);return{files,head:git(['rev-parse','HEAD']),index:git(['ls-files','--stage'])}};
 const before=snapshot();save(join(evidence,'before.json'),before);
 const timeline:any[]=[],http:any[]=[];let screen='',cursor=0,phase='',step=0,error:string|undefined,exitCode:number|undefined;
 const done=(text:string)=>streamFixture([{type:'text',text}]);
 const calls=(...values:any[])=>streamFixture(values,'tool_use');
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const body:any=await req.json();let wire:string;
  try{
   const n=step++,last=body.messages.at(-1)?.content,decoded=Array.isArray(last)?last.filter((x:any)=>x.type==='tool_result').map((x:any)=>{try{return JSON.parse(x.content)}catch{return x.content}}):[];
   if(phase==='build'){
    if(n===0)wire=calls(tool('read-build','read',{path:path('a.txt')}));
    else if(n===1){assert.equal(decoded[0].content,'before\n');wire=calls(tool('edit-build','edit',{path:path('a.txt'),base_version:decoded[0].version,old_text:'before',new_text:'after'}),tool('helper','write',{path:path('helper.txt'),content:'helper\n'}))}
    else if(n===2){assert(decoded.every((x:any)=>x.status==='applied'));wire=calls(tool('verify','bash',{command:`bun ${path('verify.cjs')}`}))}
    else if(n===3){assert(JSON.stringify(last).includes('VERIFIED'));wire=done('BUILD_WORK_DONE')}
    else {assert.equal(n,4);assert(typeof last==='string'&&last.includes('Axi自动收尾复核'));wire=done('BUILD_REVIEW_DONE')}
   }else if(phase==='conflict'){
    if(n===0)wire=calls(tool('read-conflict','read',{path:path('a.txt')}));
    else if(n===1)wire=calls(tool('edit-conflict','edit',{path:path('a.txt'),base_version:decoded[0].version,old_text:'after',new_text:'bad'}),tool('denied','write',{path:path('denied.txt'),content:'bad'}));
    else if(n===2){assert.equal(decoded[0].code,'stale_version');assert.equal(decoded[1].code,'user_denied');wire=calls(tool('bash-denied','bash',{command:`printf bad > ${path('denied.txt')}`}))}
    else {assert.equal(n,3);assert(JSON.stringify(last).includes('保留用户工作'));wire=done('CONFLICT_DONE')}
   }else if(phase==='strict'){
    if(n===0)wire=calls(tool('strict','read',{path:path('a.txt')}));else{assert.equal(n,1);assert.equal(decoded[0].content,'external\n');wire=done('STRICT_DONE')}
   }else if(phase==='cancel'){
    assert.equal(n,0);wire=calls(...['one','two','three'].map(x=>tool(x,'write',{path:path(x+'.txt'),content:x+'\n'})));
   }else if(phase==='continue'){
    if(n===0){const block=body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).find((x:any)=>x.tool_use_id==='three');assert.equal(JSON.parse(block.content).code,'cancelled_not_started');wire=calls(tool('bounded','read',{path:path('large.txt')}))}
    else {assert.equal(n,1);assert.equal(decoded[0].truncated,true);assert.equal(decoded[0].end_line,200);assert.equal(decoded[0].next_offset,201);wire=done('CONTINUE_DONE')}
   }else throw Error('未声明的任务');
  }catch(e){error=String(e);wire=done('FIXTURE_ERROR')}
  http.push({at:new Date().toISOString(),phase,request:body,response:wire});return new Response(wire,{headers:{'content-type':'text/event-stream'}});
 }});
 const entry=location==='checkout'?join(root,'src/main.ts'):join(source,'src/main.ts');
 const args=location==='checkout'?[process.execPath,'run','axi']:[process.execPath,'run',entry];
 const child=Bun.spawn(args,{cwd:root,env:{PATH:process.env.PATH,HOME:parent,TMPDIR:tmpdir(),LANG:'en_US.UTF-8',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_API_KEY:'synthetic-local-key',NO_COLOR:'1',TERM:'xterm-256color'},terminal:{cols:160,rows:45,data(_t,b){screen+=new TextDecoder().decode(b);timeline.push({kind:'output',at:new Date().toISOString(),base64:Buffer.from(b).toString('base64')})}}});
 const term=child.terminal!,clean=()=>screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replaceAll('\r','');
 const send=(s:string)=>{timeline.push({kind:'input',at:new Date().toISOString(),text:s});term.write(s+'\n')};
 const wait=async(s:string)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(error)throw Error(error);const i=clean().indexOf(s,cursor);if(i>=0){cursor=i+s.length;return}await Bun.sleep(5)}throw Error('未看到 '+s)};
 const prompt=()=>wait('你 [medium] > '),editPrompt=()=>wait('应用这次修改？[y/N] ');
 const start=(s:string)=>{phase=s;step=0;send(s)};
 const protect=(name:string,allowed:string[])=>{const after=snapshot();save(join(evidence,name+'.json'),after);assert.equal(after.head,before.head);assert.equal(after.index,before.index);assert.deepEqual(after.files.filter(x=>!allowed.includes(x.path)),before.files.filter(x=>!allowed.includes(x.path)));return after};
 try{
  await prompt();start('build');await editPrompt();send('y');await editPrompt();send('y');await wait('执行这次调用？[y/N] ');send('y');await wait('BUILD_REVIEW_DONE');await prompt();
  assert.equal(readFileSync(join(root,path('a.txt')),'utf8'),'after\n');assert.equal(readFileSync(join(root,path('helper.txt')),'utf8'),'helper\n');protect('after-build',[path('a.txt'),path('helper.txt')]);
  start('conflict');await editPrompt();writeFileSync(join(root,path('a.txt')),'external\n');save(join(evidence,'after-controller.json'),snapshot());send('y');await editPrompt();send('');await wait('拒绝理由（选填，回车跳过）：');send('保留用户工作');await wait('执行这次调用？[y/N] ');send('n');await wait('拒绝理由（选填，回车跳过）：');send('保留用户工作');await wait('CONFLICT_DONE');await prompt();
  assert.deepEqual(snapshot(),JSON.parse(readFileSync(join(evidence,'after-controller.json'),'utf8')));
  send('/permissions strict');await wait('权限模式：strict');await prompt();start('strict');await wait('执行这次读取？[y/N] ');send('y');await wait('STRICT_DONE');await prompt();
  send('/permissions project');await wait('权限模式：project');await prompt();start('cancel');await editPrompt();send('y');await editPrompt();const count=http.length;timeline.push({kind:'cancel-barrier',at:new Date().toISOString()});term.write('\x03');await wait('已中止。');await prompt();assert.equal(http.length,count);assert.equal(readFileSync(join(root,path('one.txt')),'utf8'),'one\n');assert(!existsSync(join(root,path('two.txt'))));assert(!existsSync(join(root,path('three.txt'))));
  start('continue');await wait('CONTINUE_DONE');await prompt();send('/exit');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);exitCode=await child.exited;clearTimeout(timer);assert.equal(exitCode,0);
  protect('after',[path('a.txt'),path('helper.txt'),path('one.txt')]);assert.equal(readFileSync(join(root,path('a.txt')),'utf8'),'external\n');
  const logs=join(root,'.axi/logs'),names=readdirSync(logs).filter(x=>x.endsWith('.jsonl'));assert.equal(names.length,1);assert.equal(lstatSync(join(logs,names[0]!)).mode&0o777,0o600);
  const native=readFileSync(join(logs,names[0]!),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.deepEqual(native.filter(x=>x.kind==='request').map(x=>x.data.body),http.map(x=>x.request));
  const ends=native.filter(x=>x.kind==='task_end').map(x=>x.data);assert.equal(ends.length,5);assert.deepEqual(ends.map(x=>x.outcome),['completed','completed','completed','interrupted','completed']);assert.equal(ends[0].reviewed,true);assert.equal(ends[0].budget.workRequests,4);assert.equal(ends[0].budget.reviewRequests,1);
  assert(native.some(x=>x.kind==='permission'&&x.data.source==='project_rule'));assert(native.some(x=>x.kind==='permission'&&x.data.mode==='strict'&&x.data.allowed));assert(!JSON.stringify(native).includes('synthetic-local-key'));assert(!readdirSync(root).some(x=>x.startsWith('.axi-tmp-')));
  if(location==='checkout')verifySource(root,identity);save(join(evidence,'native-audit.json'),{ends,requests:http.length,root,entry,sourceHash:identity.sourceHash,logMode:'0600',filesAndGitPreserved:true});
 }catch(e){error=String(e)}finally{
  child.kill('SIGKILL');await child.exited;term.close();server.stop(true);writeFileSync(join(evidence,'terminal.raw'),screen);save(join(evidence,'timeline.json'),timeline);save(join(evidence,'http.json'),http);save(join(evidence,'final-snapshot.json'),snapshot());if(existsSync(join(root,'.axi')))cpSync(join(root,'.axi'),join(evidence,'native-axi'),{recursive:true});rmSync(parent,{recursive:true,force:true});
 }
 const row={id,location,repeat,passed:!error&&exitCode===0,error,exitCode,requests:http.length};rows.push(row);save(join(out,'results.json'),{sourceHash:identity.sourceHash,rows});console.log(JSON.stringify(row));if(!row.passed){process.exitCode=1;break runs}
}
verifySource(source,identity);
