import {join} from 'node:path';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {docker,command,save} from '../core.ts';
import {FRESH,STUDY,IMAGE,tasks,sources,preparationGate} from './settings.ts';
preparationGate();
for(const task of tasks){
 const {repo,commit}=sources[task],id=task.slice(-1),root=join(FRESH,'sources',repo),dest=join(STUDY,'tasks',id);mkdirSync(dest,{recursive:true,mode:0o700});
 if((await command(['git','-C',root,'rev-parse','HEAD'])).stdout.trim()!==commit)throw Error('上游源码不符');
 if(existsSync(join(dest,'dependencies.json')))throw Error('不重复生成已固定依赖');
 const volume=`axi-review-fresh-deps-${id.toLowerCase()}-20261114`,name=`axi-review-fresh-prepare-${id.toLowerCase()}`;
 if((await docker(['volume','inspect',volume],undefined,true)).exitCode===0)throw Error('依赖卷已存在，先检查原现场');
 await docker(['volume','create','--label','axi.eval.study=v1-review-20261114',volume]);
 await docker(['run','-d','--name',name,'--network','bridge','--entrypoint','sleep','--mount',`type=volume,src=${volume},dst=/deps`,IMAGE,'infinity']);
 try{
  await docker(['exec','-i',name,'sh','-c','cat > /deps/package.json'],readFileSync(join(root,'package.json'),'utf8'));
  const install=await docker(['exec','-w','/deps',name,'npm','install','--ignore-scripts','--no-audit','--no-fund'],undefined,true,600000);save(join(dest,'install.json'),install);if(install.exitCode||install.timedOut)throw Error('新题依赖安装失败');
  const lock=(await docker(['exec',name,'cat','/deps/package-lock.json'])).stdout;writeFileSync(join(dest,'package-lock.json'),lock,{mode:0o600});
  const inventory=await docker(['exec','-w','/deps',name,'npm','ls','--all','--json'],undefined,true);save(join(dest,'dependencies.json'),{volume,repo,commit,...inventory});if(inventory.exitCode)throw Error('依赖树不完整');
  const bins=await docker(['exec',name,'ls','-l','/deps/node_modules/.bin']);save(join(dest,'binaries.json'),bins);
  if(task==='V1-D')await docker(['exec',name,'mkdir','-p','/deps/node_modules/.cache']);
  await docker(['exec',name,'chmod','-R','a+rX','/deps']);
  console.log(JSON.stringify({task,repo,commit,volume,installed:true}));
 }finally{await docker(['rm','-f',name],undefined,true)}
}
