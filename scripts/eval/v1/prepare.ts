import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT,docker,command,save,type Snapshot} from '../core.ts';
import {file,snapshotHash} from '../c7/tasks.ts';
import {STUDY,IMAGE} from './settings.ts';
const freeze=JSON.parse(readFileSync(join(STUDY,'product-freeze.json'),'utf8'));
if(!freeze.commit)throw Error('必须先冻结产品');
for(const [id,repo,sha] of [['A','p-limit','4d4ec71803d8736567249c3dde06ea82795ae7c7'],['B','emittery','c401cf0bc62731eb1d1ff2ad4afdcff0fb4f8d1c']] as const){
 const root=join(STUDY,'upstream',repo),dest=join(STUDY,'tasks',id);mkdirSync(dest,{recursive:true,mode:0o700});
 if(existsSync(join(dest,'input.json')))throw Error('不覆盖已冻结任务');
 if((await command(['git','-C',root,'rev-parse','HEAD'])).stdout.trim()!==sha)throw Error('上游版本错误');
 const paths=(await command(['git','-C',root,'ls-files','-z'])).stdout.split('\0').filter(Boolean);
 const files:Snapshot={};const omitted:string[]=[];
 for(const p of paths){if(p.startsWith('media/')){omitted.push(p);continue;} files[p]={type:"file",mode:0o644,data:readFileSync(join(root,p)).toString("base64")};}
 const volume='axi-v1-deps-'+id.toLowerCase()+'-20261112';
 if((await docker(['volume','inspect',volume],undefined,true)).exitCode===0)throw Error('依赖卷已存在，需检查原现场');
 await docker(['volume','create','--label','axi.eval.study=v1-20261112',volume]);
 const prep='axi-v1-prepare-'+id.toLowerCase();
 await docker(['run','-d','--name',prep,'--network','bridge','--entrypoint','sleep','--mount',`type=volume,src=${volume},dst=/deps`,IMAGE,'infinity']);
 try{
  await docker(['exec','-i',prep,'sh','-c','cat > /deps/package.json'],readFileSync(join(root,'package.json'),'utf8'));
  const result=await docker(['exec','-w','/deps',prep,'npm','install','--ignore-scripts','--no-audit','--no-fund'],undefined,true,600000);save(join(dest,'install.json'),result);if(result.exitCode)throw Error('依赖安装失败');
  const lock=(await docker(['exec',prep,'cat','/deps/package-lock.json'])).stdout;writeFileSync(join(dest,'package-lock.json'),lock,{mode:0o600});files['package-lock.json']=file(lock);
  const inventory=await docker(['exec','-w','/deps',prep,'npm','ls','--all','--json'],undefined,true);save(join(dest,'dependencies.json'),{volume,...inventory});
  await docker(['exec',prep,'chmod','-R','a+rX','/deps']);
 }finally{await docker(['rm','-f',prep],undefined,true);}
 files['eval/brief.md']=file(readFileSync(join(ROOT,`evals/specs/v1-holdout-v1/${id}/brief.md`),'utf8'));
 files['eval/ava.config.mjs']=file('export default {cache: false};\n');
 files['eval/environment.md']=file(`# 环境\n\nNode 24.22.2 / Bun 1.3.14，预装依赖来自固定 package-lock.json，node_modules 只读。候选没有公网，无需安装。\n\n- 原上游运行测试：\`node node_modules/ava/entrypoints/cli.mjs --config eval/ava.config.mjs\`\n- 原上游类型测试：\`node node_modules/tsd/dist/cli.js\`\n- 新增回归：\`node --test eval-tests/*.test.mjs\`\n- 可选格式检查：\`node node_modules/xo/cli.js\`（不作为本题必须门槛）\n\n新增回归文件必须位于 eval-tests/，测试可用标准 node:test，不能引入依赖。自动验收会用原始上游文件恢复保护项再运行，并将新增回归放到原始实现复验。缺少 API 的旧实现应由断言清楚指出，不能仅靠导入失败或进程超时。候选无需看到保留检查。\n`);
 files['user/policy.txt']=file('用户已修改，保留此行：本周只做当前接口。\r\n',0o640);files['user/notes.txt']=file('未跟踪的用户记录🙂\n',0o600);
 const protect=[...Object.keys(files).filter(p=>!['index.js','index.d.ts','readme.md'].includes(p)),'eval/protected-files.json'].sort();
 files['eval/protected-files.json']=file(JSON.stringify(protect,null,2)+'\n');
 save(join(dest,'input.json'),files);save(join(dest,'manifest.json'),{id,repo,url:`https://github.com/sindresorhus/${repo}`,commit:sha,omitted,dependencyVolume:volume,inputSha256:snapshotHash(files),productFreeze:freeze.commit,created:new Date().toISOString(),protected:protect});
 console.log(JSON.stringify({id,files:Object.keys(files).length,sha,snapshotHash:snapshotHash(files)}));
}
