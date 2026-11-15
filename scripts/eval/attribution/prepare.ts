import {join} from 'node:path';
import {readFileSync,copyFileSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {ROOT,save,execute} from '../core.ts';
import {file,contents,snapshotHash} from '../v1/tasks.ts';
import {STUDY,HISTORY,tasks,read,assertPreparation,IMAGE} from './config.ts';
import {reference,fixture} from './tasks.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {withResources} from './resources.ts';
assertPreparation();
for(const task of tasks){
 const id=task.slice(-1),old=join(HISTORY,'tasks',id),dest=join(STUDY,'tasks',id);mkdirSync(dest,{recursive:true,mode:0o700});
 if(existsSync(join(dest,'input.json')))throw Error('不覆盖已固定输入');
 const seed=read(join(old,'input.json')),prior=read(join(old,'manifest.json'));
 if(snapshotHash(seed)!==prior.inputSha256)throw Error('历史输入已改变');
 for(const name of ['dependencies.json','package-lock.json'])copyFileSync(join(old,name),join(dest,name));
 // P组公开资料逐字继承，避免在诊断时额外提示过去的失败答案。
 save(join(dest,'input.json'),seed);save(join(dest,'manifest.json'),{...prior,study:'v1-attribution-20261115',baseTask:task,priorInputSha256:prior.inputSha256,inputSha256:snapshotHash(seed)});
}
const good=reference('V1-E','primary',false),path='index.ts',source=contents(good[path]!);
const before='!hasSettled && registration.valid',after='!hasSettled && registration.valid && (!store.shared || store.shared.generation === generation) && (!keyState || keyState.version === keyVersion)';
if(source.split(before).length!==2)throw Error('单缺陷定位不唯一');
const faulty=structuredClone(good);faulty[path]=file(source.replace(before,after));
const repairBrief='# 修复已有p-memoize实现\n\n这份实现已经提供以下API，但仍有行为缺陷。请自行定位并修复，使完整公开契约成立。保留正常行为、类型和用户修改。新增回归须在本次接手的有缺陷代码上因目标行为断言失败，在修复后通过。已有文档正确时无需制造文档修改。\n\n以下是完整公开契约；其中原“扩展实现”描述API目标，本次交付是修复现有实现。\n\n'+contents(faulty['eval/brief.md']!);
for(const id of ['U','Q']){
 const dest=join(STUDY,'tasks',id);mkdirSync(dest,{recursive:true,mode:0o700});
 const seed=structuredClone(faulty);seed['eval/brief.md']=file(repairBrief+(id==='Q'?'\n\n另有定位援助：读取eval/assistance/failure.txt；先执行npm run build，再执行node --test --test-reporter=tap eval/assistance/reproduce.mjs。可以将该复现转为新增回归，须说明来源。\n':''));
 const manifest=read(join(STUDY,'tasks/E/manifest.json'));
 if(id==='Q')seed['eval/assistance/reproduce.mjs']=file(fixture('assistance.mjs'));
 const protectedPaths=[...manifest.protected,...(id==='Q'?['eval/assistance/reproduce.mjs','eval/assistance/failure.txt']:[])];
 seed['eval/protected-files.json']=file(JSON.stringify(protectedPaths,null,2)+'\n');
 for(const name of ['dependencies.json','package-lock.json'])copyFileSync(join(STUDY,'tasks/E',name),join(dest,name));
 save(join(dest,'input.json'),seed);save(join(dest,'manifest.json'),{...manifest,task:'V1-'+id,baseTask:'V1-E',repair:true,assisted:id==='Q',protected:protectedPaths,inputSha256:snapshotHash(seed)});
}
await withResources('prepare-assistance',async()=>{
 const window=new GradeWindow(Math.min(Date.now()+120000,assertPreparation().preparationDeadline)),name='axi-attribution-aid-'+Date.now(),out=join(STUDY,'assistance-preparation');
 try{
  const seed=read(join(STUDY,'tasks/Q/input.json')),r=await isolated(IMAGE,'V1-Q',name,seed,window);
  const build=await execute(r,['bash','-lc','npm run build'],undefined,true,window.remaining('build'));save(join(out,'build.json'),build);if(build.exitCode||build.timedOut)throw Error('Q起点构建失败');
  const result=await execute(r,['node','--test','--test-reporter=tap','eval/assistance/reproduce.mjs'],undefined,true,window.remaining('reproduction'));save(join(out,'reproduction.json'),result);
  if(result.exitCode!==1||result.timedOut||!result.stdout.includes('ERR_ASSERTION')||!result.stdout.includes('# fail 1'))throw Error('援助复现没有按目标行为失败');
  seed['eval/assistance/failure.txt']=file('命令：node --test --test-reporter=tap eval/assistance/reproduce.mjs\n以下是在本题原态上实际取得的输出：\n\n'+result.stdout+result.stderr);
  const m=read(join(STUDY,'tasks/Q/manifest.json'));save(join(STUDY,'tasks/Q/input.json'),seed);save(join(STUDY,'tasks/Q/manifest.json'),{...m,inputSha256:snapshotHash(seed)});
 }finally{save(join(out,'cleanup.json'),await cleanup([name],window))}
});
const u=read(join(STUDY,'tasks/U/input.json')),q=read(join(STUDY,'tasks/Q/input.json'));
const diff=Object.keys({...u,...q}).filter(p=>JSON.stringify(u[p])!==JSON.stringify(q[p])).sort();
const allowed=['eval/assistance/failure.txt','eval/assistance/reproduce.mjs','eval/brief.md','eval/protected-files.json'];
if(JSON.stringify(diff)!==JSON.stringify(allowed))throw Error('援助组有未声明输入差异');
save(join(STUDY,'input-declaration.json'),{P:'byte-identical to closed reentry inputs',Q:{mutation:{path,before,after},reference:'primary',allowedDifferences:allowed,actualDifferences:diff,protectedDifference:'only protecting assistance files; all pre-existing protection identical'},hashes:Object.fromEntries(['E','D','U','Q'].map(id=>[id,read(join(STUDY,'tasks',id,'manifest.json')).inputSha256]))});
console.log(JSON.stringify({complete:true,inputHashes:read(join(STUDY,'input-declaration.json')).hashes}));
