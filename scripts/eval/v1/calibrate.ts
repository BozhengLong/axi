import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {save,execute} from '../core.ts';
import {isolated} from './runtime.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {taskFiles,reference,file,contents,snapshotHash} from './tasks.ts';
import {reference as c7Reference} from '../c7/tasks.ts';
import {grade} from './grade.ts';
import {STUDY,IMAGE,type TaskId} from './settings.ts';
const stamp=Date.now(),directory=join(STUDY,'calibration-'+stamp),results:any[]=[],frozen=fingerprint();
const persist=(complete=false)=>{const report={complete,directory,image:IMAGE,sourceHash:frozen.sourceHash,hashes:frozen.hashes,results};save(join(directory,'results.json'),report);save(join(STUDY,'calibration-latest.json'),report)};
async function run(task:TaskId,kind:string,files:ReturnType<typeof taskFiles>,expect:(r:Awaited<ReturnType<typeof grade>>)=>boolean){
 const seed=taskFiles(task),r=await grade(IMAGE,task,`cal-${stamp}-${task}-${kind}`,seed,files,join(directory,task+'-'+kind));
 const publicRecipes:any[]=[];
 if(kind==='reference'&&task.startsWith('V1-')){
  const environment=contents(seed['eval/environment.md']!);
  const isolatedRun=await isolated(IMAGE,task,`cal-${stamp}-${task}-recipes`,files);
  try{
   for(const label of ['原上游运行测试','原上游类型测试','新增回归']){
    const command=environment.match(new RegExp(label+'：`([^`]+)`'))?.[1];if(!command)throw Error('公开命令缺失：'+label);
    const result=await execute(isolatedRun,['sh','-c',command],undefined,true,120000);
    publicRecipes.push({label,command,...result});
   }
   const xo=await execute(isolatedRun,['./node_modules/.bin/xo','--version'],undefined,true,30000);publicRecipes.push({label:'可选工具入口',...xo});
  }finally{await isolatedRun.close();}
  save(join(directory,task+'-public-recipes.json'),publicRecipes);
 }
 const passed=expect(r)&&publicRecipes.every(r=>r.exitCode===0);
 results.push({task,kind,passed,inputSha256:snapshotHash(seed),candidateSha256:snapshotHash(files),codePassed:r.codePassed,regressionPassed:r.regressionPassed,publicRecipes:publicRecipes.map(r=>({label:r.label,exitCode:r.exitCode})),failures:r.checks.filter(x=>!x.pass).map(x=>x.id)});
 persist();console.log(JSON.stringify(results.at(-1)));if(!passed)throw Error('验收校准失败');
}
for(const task of ['V1-A','V1-B'] as const){
 await run(task,'baseline',taskFiles(task),r=>!r.codePassed&&r.checks.filter(x=>['upstream','upstreamTypes','PROTECT'].includes(x.id)).every(x=>x.pass));
 const ref=reference(task);await run(task,'reference',ref,r=>r.codePassed&&r.regressionPassed);
 const variants=task==='V1-A'?[
  ['pending','get: () => pendingCount,','get: () => queue.size,'],
  ['idle','if (activeCount !== 0 || pendingCount !== 0) return;','if (pendingCount !== 0) return;'],
  ['reason','reject(signal.reason);','reject(signal.reason || new Error("cancelled"));'],
 ]:[
  ['drop',"if (overflow === 'drop-newest') return;","if (overflow === 'drop-newest') queue.shift();"],
  ['cleanup','for (const eventName of eventNames) {','for (const eventName of eventNames.slice(0, 1)) {'],
  ['reason','fail(signal.reason)','fail(signal.reason || new Error("cancelled"))'],
 ];
 for(const [kind,from,to] of variants){const m=structuredClone(ref),source=contents(m['index.js']!);if(!source.includes(from!))throw Error('变体锚点缺失');m['index.js']=file(source.replace(from!,to!));await run(task,kind!,m,r=>!r.codePassed&&r.checks.some(c=>c.id==='CONTRACT'&&!c.pass));}
 const vacuous=structuredClone(ref);vacuous['eval-tests/reference.test.mjs']=file("import test from 'node:test';import assert from 'node:assert/strict';test('无效测试',()=>assert.ok(true));\n");await run(task,'vacuous',vacuous,r=>r.codePassed&&!r.regressionPassed);
}
for(const task of ['C7-L','C7-O'] as const){const seed=taskFiles(task);await run(task,'reference',c7Reference(task,seed),r=>r.codePassed&&r.regressionPassed);}
persist(true);
