import{join}from'node:path';
import{execute,save}from'../core.ts';
import{fingerprint}from'../complex/fingerprint.ts';
import{isolated}from'../v1/runtime.ts';
import{reference,file,fixture,taskFiles,contents,snapshotHash}from'../v1/tasks.ts';
import{authorization,STUDY,IMAGE}from'./config.ts';
const a=authorization(),compat=process.argv[2]==='--compatibility';
if(!compat&&process.argv[2]!=='--offline')throw Error('需要 --offline 或 --compatibility');
const stamp=Date.now(),directory=join(STUDY,(compat?'compatibility-':'stability-')+stamp),frozen=fingerprint(),results:any[]=[];
const inputs=Object.fromEntries((['V1-A','V1-B']as const).map(t=>[t,snapshotHash(taskFiles(t))]));
const persist=(complete=false)=>{const r={complete,directory,image:IMAGE,sourceHash:frozen.sourceHash,inputs,profile:'node22',results};save(join(directory,'results.json'),r);save(join(STUDY,compat?'compatibility-latest.json':'stability-latest.json'),r)};
persist();
for(const task of ['V1-A','V1-B']as const){
 const files=reference(task);files['eval-oracle/types.mts']=file(fixture(`oracle/${task.slice(-1)}-types.mts`));files['eval-oracle/invalid.mts']=file('const value: number = "intentional type error";\nexport {value};\n');
 const r=await isolated(IMAGE,task,`stable-${stamp}-${task}`,files);
 async function check(kind:string,repeat:number,args:string[],expected:number,timeout=120000){
  if(Date.now()+timeout>a.workDeadline)throw Error('截止不允许继续检查');
  const result=await execute(r,args,undefined,true,timeout);const passed=!result.timedOut&&result.exitCode===expected&&(kind!=='invalid'||result.stdout.includes('error TS2322:'));
  results.push({task,kind,repeat,passed,args,...result});persist();if(!passed)throw Error(`Node22兼容/稳定性失败:${task}/${kind}/${repeat}`);
 }
 try{
  if(compat){await check('node-version',0,['node','--version'],0);if(!results.at(-1).stdout.includes('v22.23.5'))throw Error('Node版本不符');await check('dependency-tree',0,['npm','ls','--all','--json'],0);}
  else for(let repeat=1;repeat<=50;repeat++)for(const kind of repeat%2?['valid','invalid']:['invalid','valid'])await check(kind,repeat,['node','/opt/toolchain/node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ESNext','--module','NodeNext','--moduleResolution','NodeNext',`eval-oracle/${kind==='valid'?'types':'invalid'}.mts`],kind==='valid'?0:2,10000);
  const env=contents(taskFiles(task)['eval/environment.md']!);
  for(let repeat=1;repeat<=(compat?1:20);repeat++)for(const label of ['原上游运行测试','原上游类型测试','新增回归']){
   const command=env.match(new RegExp(label+'：`([^`]+)`'))?.[1];if(!command)throw Error('公开命令缺失');await check(label,repeat,['sh','-c',command],0);
  }
 }finally{await r.close()}
 console.log(JSON.stringify({task,checks:results.filter(x=>x.task===task).length,passed:true}));
}
persist(true);
