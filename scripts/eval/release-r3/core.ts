import {mkdirSync, writeFileSync, unlinkSync, existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadConfig} from '../../../src/config.ts';
import {save, docker, control, execute, freeze as legacyFreeze, encodeFiles, validateTaskEnvironment, type Batch, type Runtime, type SeedFiles} from '../core.ts';
import {validatePolicy, type RunPolicy} from './policy.ts';
import {collectNativeTrace} from './trace.ts';
export {save, command, docker, control, execArgs, execute, snapshot, type Batch, type Runtime, type Snapshot} from '../core.ts';

export async function freeze(runtime:Pick<Runtime,'name'> & Partial<Pick<Runtime,'directory'>>){
  // 监督器也会发信号。先等待它完成，避免两个收尾进程相互终止。
  if(runtime.directory){
    const configPath=join(runtime.directory,'guardian-config.json');
    if(existsSync(configPath)){
      const config=JSON.parse(readFileSync(configPath,'utf8'));if(config.container!==runtime.name)throw Error('监督器身份不符');
      const request=join(runtime.directory,'guardian-stop-request.json'),expected={action:'finish',batch:config.batch};
      if(existsSync(request)){if(JSON.stringify(JSON.parse(readFileSync(request,'utf8')))!==JSON.stringify(expected))throw Error('监督器关闭请求不符');}
      else save(request,expected);
      const started=performance.now(),until=started+10000,result=join(runtime.directory,'guardian-result.json');
      while(!existsSync(result)){
        if(existsSync(join(runtime.directory,'guardian-failure.json'))||performance.now()>until)throw Error('监督器尚未完成，不能并行收尾');
        await Bun.sleep(20);
      }
      const closed=JSON.parse(readFileSync(result,'utf8'));if(closed.closed!==true||closed.deadline!==config.deadline)throw Error('监督器关闭证明不符');
      const proof=join(runtime.directory,'freeze-guardian-wait.json');
      if(!existsSync(proof))save(proof,{at:new Date().toISOString(),waitMs:performance.now()-started,guardianClosed:true,reason:closed.reason});
    }
  }
  await legacyFreeze(runtime);
}

export type R3Batch = Batch & {study:string; bundle:string; mode:'mock'|'real'};
const image = 'sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1';

export async function initialize(study:string,bundle:string,mode:'mock'|'real',onPrepared?:(batch:R3Batch)=>void):Promise<R3Batch>{
  if(!['mock','real'].includes(mode))throw Error('必须指定R3模拟或真实模式');
  const id='r3-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+crypto.randomUUID().slice(0,8);
  const directory=join(study,'runtime',id);mkdirSync(join(directory,'relay'),{recursive:true,mode:0o700});
  const batch:R3Batch={id,directory,relay:'axi-'+id+'-relay',admin:crypto.randomUUID(),endpoint:'',image,created:new Date().toISOString(),study,bundle,mode};
  save(join(directory,'private-state.json'),batch);onPrepared?.(batch);
  const config=mode==='mock'?{url:'http://127.0.0.1:1/v1/messages',apiKey:'synthetic-r3-upstream'}:loadConfig();
  const envFile=join(directory,'relay.env');
  writeFileSync(envFile,`EVAL_ADMIN_TOKEN=${batch.admin}\nEVAL_UPSTREAM_URL=${config.url}\nEVAL_UPSTREAM_KEY=${config.apiKey}\nEVAL_MOCK_ONLY=${mode==='mock'?'1':'0'}\n`,{mode:0o600});
  try{try{
    await docker(['run','-d','--name',batch.relay,'--label','axi.eval.study='+study.split('/').at(-1),'--label','axi.eval.batch='+id,
      '--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','512m','--pids-limit','64',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--env-file',envFile,'--mount',`type=bind,src=${join(directory,'relay')},dst=/evidence`,
      '--mount',`type=bind,src=${join(bundle,'relay')},dst=/opt/eval-r3,readonly`,'-p','127.0.0.1::8787',image,'bun','/opt/eval-r3/relay.js']);
  }finally{unlinkSync(envFile);}
  batch.endpoint='http://'+(await docker(['port',batch.relay,'8787/tcp'])).stdout.trim();
  save(join(directory,'private-state.json'),batch);
  const checks=[];const until=performance.now()+10000;
  while(performance.now()<until){
    try{const ready=await control(batch,'health',{});if(ready.ready&&ready.version==='r3'){save(join(directory,'ready.json'),{ready,checks});return batch;}}
    catch(error){checks.push({at:new Date().toISOString(),error:String(error)});}
    await Bun.sleep(100);
  }
  save(join(directory,'ready-failure.json'),{checks});throw Error('R3代理未就绪');
  }catch(error){save(join(directory,'startup-failure.json'),{error:String(error)});await relayConsole(batch).catch(()=>{});await docker(['rm','-f',batch.relay],undefined,true);throw error;}
}

export async function createRuntime(batch:R3Batch,id:string,options:{executionPolicy:RunPolicy;mock?:any[];policy?:string;files?:SeedFiles;taskVolume?:string;mounts?:string[];taskEnv?:Record<string,string>;taskTmpfs?:string[];mockRetryWindowMs?:number}):Promise<Runtime>{
  validateTaskEnvironment(options);const executionPolicy=validatePolicy(options.executionPolicy);
  if(batch.mode==='mock'&&!options.mock)throw Error('模拟运行必须明确提供回复');
  if(batch.mode==='real'&&options.mock)throw Error('真实运行不能带模拟回复');
  if(options.mockRetryWindowMs!==undefined&&(batch.mode!=='mock'||!Number.isSafeInteger(options.mockRetryWindowMs)||options.mockRetryWindowMs<1))throw Error('故障注入窗口仅限明确模拟运行');
  const token=crypto.randomUUID(),name='axi-'+batch.id+'-'+id,network=name+'-net',directory=join(batch.directory,id);mkdirSync(directory,{mode:0o700});
  try{
    await docker(['network','create','--internal','--label','axi.eval.batch='+batch.id,network]);
    await docker(['network','connect',network,batch.relay]);
    const networks=JSON.parse((await docker(['inspect',batch.relay,'--format','{{json .NetworkSettings.Networks}}'])).stdout),ip=networks[network].IPAddress;
    await control(batch,'register',{id,token,executionPolicy,mock:options.mock,policy:options.policy});
    const env={...(options.taskEnv??{}),AXI_EVAL_RELAY_IP:ip,ANTHROPIC_BASE_URL:`http://${ip}:8787`,ANTHROPIC_API_KEY:token,
      AXI_RETRY_WINDOW_MS:String(options.mockRetryWindowMs??600000),CLAUDE_CONFIG_DIR:'/home/eval/.claude',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'};
    await docker(['run','-d','--name',name,'--label','axi.eval.batch='+batch.id,'--label','axi.eval.study='+batch.study.split('/').at(-1),
      '--network',network,'--user','0','--read-only','--cap-drop=ALL','--cap-add=NET_ADMIN','--cap-add=SETUID','--cap-add=SETGID','--cap-add=SETPCAP','--cap-add=CHOWN',
      '--security-opt','no-new-privileges','--cpus','2','--memory','4g','--pids-limit','256',
      ...(options.taskVolume?['--mount',`type=volume,src=${options.taskVolume},dst=/task`]:['--tmpfs','/task:rw,nosuid,size=200m,mode=755']),
      ...(options.mounts??[]).flatMap(m=>['--mount',m]),'--mount',`type=bind,src=${join(batch.bundle,'task')},dst=/opt/eval-r3,readonly`,
      ...(options.taskTmpfs??[]).flatMap(m=>['--tmpfs',m]),'--tmpfs','/home/eval:rw,nosuid,size=256m,mode=755','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777',
      ...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),image]);
    const runtime:Runtime={id,token,name,network,ip,directory,...(options.taskVolume?{taskVolume:options.taskVolume}:{})};
    await execute(runtime,['bun','/opt/eval/files.ts','seed'],encodeFiles(options.files??{}));return runtime;
  }catch(error){
    save(join(directory,'startup-failure.json'),{error:String(error)});
    await control(batch,'revoke',{id}).catch(()=>{});await control(batch,'close',{id}).catch(()=>{});await docker(['rm','-f',name],undefined,true);
    await docker(['network','disconnect',network,batch.relay],undefined,true);await docker(['network','rm',network],undefined,true);throw error;
  }
}

export async function destroyRuntime(batch:Batch,runtime:Runtime){
  await control(batch,'revoke',{id:runtime.id});
  await freeze(runtime);
  await collectNativeTrace(runtime);
  const native=JSON.parse(readFileSync(join(runtime.directory,'native/manifest.json'),'utf8'));
  if(native.status!=='collected')throw Error('原生Trace未收齐；保留冻结容器供保全，不删除唯一原件');
  await docker(['rm','-f',runtime.name],undefined,true);await docker(['network','disconnect',runtime.network,batch.relay],undefined,true);await docker(['network','rm',runtime.network],undefined,true);
}

export async function relayConsole(batch:Batch){
  if(existsSync(join(batch.directory,'relay-console-result.json')))return;
  const child=Bun.spawn(['docker','logs',batch.relay],{stdout:Bun.file(join(batch.directory,'relay-console.stdout')),stderr:Bun.file(join(batch.directory,'relay-console.stderr'))});
  const code=await child.exited;save(join(batch.directory,'relay-console-result.json'),{exitCode:code});
}
