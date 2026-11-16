import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSource,verifySource } from './source.ts';
const [rootArg,manifestArg,outputArg,platform]=process.argv.slice(2);
if(!rootArg||!manifestArg||!outputArg||!platform)throw Error('需要源码目录、清单、新证据目录和平台');
const root=resolve(rootArg),output=resolve(outputArg),identity=loadSource(root,manifestArg);
mkdirSync(output,{recursive:true});if(existsSync(join(output,'plan.json')))throw Error('拒绝覆盖已有运行');
const evaluationEnv:Record<string,string|undefined>=process.env.AXI_EVAL_ENV?JSON.parse(await Bun.file(process.env.AXI_EVAL_ENV).text()).env:{PATH:process.env.PATH,HOME:process.env.AXI_EVAL_HOME??process.env.HOME,TMPDIR:tmpdir(),LANG:'en_US.UTF-8',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',npm_config_package_manager_strict:'false',npm_config_manage_package_manager_versions:'false'};
for(const key of Object.keys(evaluationEnv))if(!['PATH','HOME','TMPDIR','LANG','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','npm_config_package_manager_strict','npm_config_manage_package_manager_versions'].includes(key))throw Error('不允许的环境字段');
if(evaluationEnv.HOME)mkdirSync(evaluationEnv.HOME,{recursive:true});
const runtime:any={platform:process.platform,arch:process.arch,bun:Bun.version};
for(const name of ['node','pnpm']){const p=Bun.spawnSync([name,'--version'],{cwd:root,env:evaluationEnv});runtime[name]={code:p.exitCode,value:p.stdout.toString().trim(),error:p.stderr.toString()};}
writeFileSync(join(output,'runtime.json'),JSON.stringify(runtime,null,2));
if(identity.kind==='candidate'&&(runtime.platform!==(platform==='macos'?'darwin':'linux')||runtime.bun!=='1.3.14'||runtime.node.code!==0||runtime.node.value!=='v22.23.5'||runtime.pnpm.code!==0||runtime.pnpm.value!=='10.34.9'))throw Error('正式工程运行时身份不符');
const commands=[['bun','run','typecheck'],...Array.from({length:5},()=>['bun','test'])];
writeFileSync(join(output,'plan.json'),JSON.stringify({identity,platform,commands,createdAt:new Date().toISOString()},null,2));
const rows:any[]=[];
for(const [index,command] of commands.entries()){
 const evidence=join(output,`protected-${index}`),started=Date.now();
 const child=Bun.spawn(command,{cwd:root,env:{...evaluationEnv,AXI_P02_TEST_EVIDENCE:evidence},stdout:Bun.file(join(output,`${index}.stdout`)),stderr:Bun.file(join(output,`${index}.stderr`))});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},15*60_000);const exitCode=await child.exited;clearTimeout(timer);
 const row={index,command,exitCode,timedOut,elapsedMs:Date.now()-started};rows.push(row);writeFileSync(join(output,'results.json'),JSON.stringify({identity:identity.sourceHash,platform,rows,qualified:rows.length===6&&rows.every(x=>x.exitCode===0&&!x.timedOut)},null,2));console.log(JSON.stringify(row));
 if(index===0&&exitCode!==0)break;
}
verifySource(root,identity);process.exitCode=rows.length===6&&rows.every(x=>x.exitCode===0&&!x.timedOut)?0:1;
