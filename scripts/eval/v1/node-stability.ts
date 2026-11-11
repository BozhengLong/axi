import {join} from 'node:path';
import {execute,save} from '../core.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {isolated} from './runtime.ts';
import {reference,file,fixture,taskFiles,snapshotHash} from './tasks.ts';
import {IMAGE,STUDY} from './settings.ts';
import {TYPECHECK_NODE} from './node-verifier.ts';

// 离线验证参考实现与确定错误；不启动模型，不允许重试掩盖不稳定结果。
if(process.argv[2]!=='--offline'||!IMAGE.startsWith('sha256:'))throw Error('需要 --offline 和固定镜像 digest');
const stamp=Date.now(),directory=join(STUDY,'node-stability-'+stamp),frozen=fingerprint(),results:any[]=[];
const inputs=Object.fromEntries((['V1-A','V1-B'] as const).map(t=>[t,snapshotHash(taskFiles(t))]));
const persist=(complete=false)=>{
 const report={complete,directory,image:IMAGE,sourceHash:frozen.sourceHash,inputs,nodeArguments:TYPECHECK_NODE,results};
 save(join(directory,'results.json'),report);save(join(STUDY,'node-stability-latest.json'),report);
};
persist();
for(const task of ['V1-A','V1-B'] as const){
 const files=reference(task);
 files['eval-oracle/types.mts']=file(fixture(`oracle/${task.slice(-1)}-types.mts`));
 files['eval-oracle/invalid.mts']=file('const value: number = "intentional type error";\nexport {value};\n');
 const r=await isolated(IMAGE,task,`node-stability-${stamp}-${task}`,files);
 try{
  const version=await execute(r,['node','--version']);
  if(version.stdout.trim()!=='v24.22.2')throw Error('不是本次已诊断的 Node 版本');
  for(let repeat=1;repeat<=25;repeat++)for(const kind of repeat%2?['valid','invalid']:['invalid','valid']){
   const args=[...TYPECHECK_NODE,'/opt/toolchain/node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ESNext','--module','NodeNext','--moduleResolution','NodeNext',`eval-oracle/${kind==='valid'?'types':'invalid'}.mts`];
   const result=await execute(r,args,undefined,true,10000);
   const passed=!result.timedOut&&(kind==='valid'?result.exitCode===0:result.exitCode===2&&result.stdout.includes('error TS2322:'));
   results.push({task,repeat,kind,passed,nodeVersion:version.stdout.trim(),args,...result});persist();
   if(!passed)throw Error(`Node 稳定性检查失败：${task}/${kind}/${repeat}`);
  }
 }finally{await r.close();}
 console.log(JSON.stringify({task,checks:50,passed:true}));
}
persist(true);
