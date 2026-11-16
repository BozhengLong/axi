import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, lstatSync, symlinkSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSource, verifySource } from './source.ts';

// 真CLI、真PTY、本地HTTP。批准前按屏障替换身份，不改产品或注入产品钩子。
const [candidateArg, manifestArg, outputArg, platform] = process.argv.slice(2);
if (!candidateArg || !manifestArg || !outputArg || !platform) throw Error('需要C目录、证据目录、平台');
const candidate=resolve(candidateArg),output=resolve(outputArg);
const identity=loadSource(candidate,manifestArg);
mkdirSync(output,{recursive:true});
if(await Bun.file(join(output,'plan.json')).exists()) throw Error('拒绝覆盖已有证据');
const variants=[...['read','glob','grep'].flatMap(tool=>['unchanged','replace-target','deny-replaced'].map(variant=>({tool,variant}))),{tool:'read',variant:'replace-parent'},{tool:'read',variant:'symlink-target'}];
const plan={candidate:identity.commit,sourceHash:identity.sourceHash,sourceKind:identity.kind,platform,variants,repeats:5,contract:'P-02 / 设计07 §4.2；等待确认期间目标或父目录身份变化使原提案失效',expected:'unchanged returns original; all replacements reject without replacement data; denial remains denial; no subject file changes',createdAt:new Date().toISOString()};
writeFileSync(join(output,'plan.json'),JSON.stringify(plan,null,2));
const {streamFixture}=await import(join(candidate,'tests/fixtures.ts'));
const summaries:any[]=[];
for(const {tool,variant} of variants) for(let repeat=1;repeat<=5;repeat++) {
 const id=`${tool}-${variant}-${repeat}`, evidence=join(output,id);mkdirSync(evidence);
 const root=realpathSync(mkdtempSync(join(tmpdir(),'axi-release-cli-')));
 mkdirSync(join(root,'sub'));writeFileSync(join(root,'sub/a.txt'),'original needle\n');writeFileSync(join(root,'bystander.txt'),'original user\n');
 const git=(args:string[])=>{const p=Bun.spawnSync(['git','-C',root,...args]);if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString()};
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial']);writeFileSync(join(root,'bystander.txt'),'user dirty must remain\n');
 const snapshot=()=>{const files:any[]=[];const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){if(['.git','.axi'].includes(name))continue;const p=join(dir,name),s=lstatSync(p);files.push({path:p.slice(root.length+1),dev:s.dev,ino:s.ino,mode:s.mode,links:s.nlink,...(s.isFile()?{bytes:readFileSync(p).toString('base64')}:{})});if(s.isDirectory())walk(p)}};walk(root);return{files,head:git(['rev-parse','HEAD']),index:git(['ls-files','--stage'])}};
 const initial=snapshot(),timeline:any[]=[],api:any[]=[];let screen='',cursor=0,exitCode:number|undefined,afterReplace:any,after:any,error:string|undefined;
 const target=tool==='read'?'sub/a.txt':'sub';
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const body=await req.json();const n=api.length;
  const wire=n===0?streamFixture([{type:'tool_use',id:'inspect',name:tool,input:{path:target,...(tool==='read'?{}:{pattern:tool==='glob'?'**/*.txt':'needle'})}}],'tool_use'):streamFixture([{type:'text',text:'LOCAL_FIXTURE_DONE'}]);
  api.push({at:new Date().toISOString(),request:body,response:wire});return new Response(wire,{headers:{'content-type':'text/event-stream'}});
 }});
 const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,TMPDIR:tmpdir(),LANG:'en_US.UTF-8'};
 const child=Bun.spawn([process.execPath,join(candidate,'src/main.ts')],{cwd:root,env:{...env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_API_KEY:'synthetic-local-key',NO_COLOR:'1',TERM:'xterm-256color'},terminal:{cols:160,rows:40,data(_t,bytes){screen+=new TextDecoder().decode(bytes);timeline.push({kind:'output',at:new Date().toISOString(),base64:Buffer.from(bytes).toString('base64')})}}});
 const term=child.terminal!;
 const clean=()=>screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replaceAll('\r','');
 const send=(text:string)=>{timeline.push({kind:'input',at:new Date().toISOString(),text});term.write(text+'\n')};
 const wait=async(text:string)=>{const deadline=Date.now()+8000;while(Date.now()<deadline){const at=clean().indexOf(text,cursor);if(at>=0){cursor=at+text.length;return}await Bun.sleep(5)}throw Error(`UI deadline waiting ${text}`)};
 try {
  await wait('你 [medium] > ');send('/permissions strict');await wait('权限模式：strict');await wait('你 [medium] > ');send('inspect');await wait('执行这次读取？[y/N] ');
  timeline.push({kind:'permission-barrier',at:new Date().toISOString(),target,variant});
  if(['replace-target','deny-replaced'].includes(variant)) {renameSync(join(root,target),join(root,target+'.old'));if(tool==='read')writeFileSync(join(root,target),'replacement needle MUST_NOT_READ\n');else{mkdirSync(join(root,target));writeFileSync(join(root,target,'replacement.txt'),'replacement needle MUST_NOT_READ\n')}}
  else if(variant==='replace-parent'){renameSync(join(root,'sub'),join(root,'sub.old'));mkdirSync(join(root,'sub'));writeFileSync(join(root,'sub/a.txt'),'replacement needle MUST_NOT_READ\n')}
  else if(variant==='symlink-target'){renameSync(join(root,target),join(root,target+'.old'));writeFileSync(join(root,'other.txt'),'replacement needle MUST_NOT_READ\n');symlinkSync('../other.txt',join(root,target))}
  afterReplace=snapshot();timeline.push({kind:'replacement-complete',at:new Date().toISOString()});
  if(variant==='deny-replaced'){send('n');await wait('拒绝理由（选填，回车跳过）：');send('keep identity boundary')}else send('y');
  await wait('LOCAL_FIXTURE_DONE');await wait('你 [medium] > ');send('/exit');
  const timeout=setTimeout(()=>child.kill('SIGKILL'),8000);exitCode=await child.exited;clearTimeout(timeout);
  after=snapshot();
 }catch(e){error=String(e)}finally{
  child.kill('SIGKILL');await child.exited;term.close();server.stop(true);
  cpSync(join(root,'.axi'),join(evidence,'native-axi'),{recursive:true});
  writeFileSync(join(evidence,'terminal.raw'),screen);writeFileSync(join(evidence,'timeline.json'),JSON.stringify(timeline,null,2));writeFileSync(join(evidence,'http.json'),JSON.stringify(api,null,2));
 }
 const request:any=api[1]?.request;const raw=request?.messages?.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).find((b:any)=>b.type==='tool_result'&&b.tool_use_id==='inspect');
 const result=raw?JSON.parse(raw.content):undefined;const rejected=raw?.is_error===true;
 const identityChanged=variant==='unchanged'?false:JSON.stringify(initial.files.filter((x:any)=>x.path===target||x.path==='sub'))!==JSON.stringify(afterReplace?.files.filter((x:any)=>x.path===target||x.path==='sub'));
 const unchanged=JSON.stringify(afterReplace)===JSON.stringify(after), leaked=JSON.stringify(raw??{}).includes('MUST_NOT_READ')||JSON.stringify(raw??{}).includes('replacement.txt');
 const expectedContent=tool==='read'?result?.content==='original needle\n':JSON.stringify(result?.results)===(tool==='glob'?JSON.stringify(['sub/a.txt']):JSON.stringify([{path:'sub/a.txt',line:1,content:'original needle\n'}]));
 const passed=!error&&exitCode===0&&api.length===2&&unchanged&&(variant==='unchanged'?!!raw&&!rejected&&expectedContent:identityChanged&&rejected&&!leaked);
 const traceFiles=readdirSync(join(evidence,'native-axi/logs')).filter(x=>x.endsWith('.jsonl'));
 const native=traceFiles.flatMap(x=>readFileSync(join(evidence,'native-axi/logs',x),'utf8').trim().split('\n').map(x=>JSON.parse(x)));
 const bodies=native.filter(x=>x.kind==='request').map(x=>x.data.body);
 const traceComplete=traceFiles.length===1&&native.filter(x=>x.kind==='task_end').length===1&&JSON.stringify(bodies)===JSON.stringify(api.map(x=>x.request));
 const row={id,tool,variant,repeat,passed:passed&&traceComplete,traceComplete,error,exitCode,requests:api.length,rejected,leaked,identityChanged,unchanged,result,initial,afterReplace,after};
 writeFileSync(join(evidence,'result.json'),JSON.stringify(row,null,2));summaries.push({id,passed:row.passed,traceComplete,rejected,leaked,identityChanged,unchanged,code:result?.code,error});
 rmSync(root,{recursive:true,force:true});
}
writeFileSync(join(output,'results.json'),JSON.stringify({plan,rows:summaries,passed:summaries.filter(x=>x.passed).length,failed:summaries.filter(x=>!x.passed).length},null,2));
console.log(JSON.stringify({total:summaries.length,passed:summaries.filter(x=>x.passed).length,failed:summaries.filter(x=>!x.passed).length,errors:summaries.filter(x=>x.error)}));

verifySource(candidate,identity);
process.exitCode=summaries.some(x=>!x.passed)?1:0;
