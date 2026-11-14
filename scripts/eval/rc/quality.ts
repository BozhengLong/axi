import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {ROOT,execute,save,type Snapshot} from '../core.ts';
import {file,contents} from '../v1/tasks.ts';
import {isolated} from '../v1/runtime.ts';
import {parseTests} from '../v1/grade.ts';
import {assertVerificationCompleted} from '../v1/verification-status.ts';
import {IMAGE} from './config.ts';
import type {TaskId} from '../v1/settings.ts';
// 只将js/javascript代码围栏视为完整JS；显式text/pseudocode围栏不参与语法判定。
// 无标记围栏和代码片段交由人工解释，不能事后为了通过而改变分类。
export function changedJS(before:string,after:string){
 const blocks=(s:string)=>[...s.matchAll(/^```(?:js|javascript)\s*\n([\s\S]*?)^```\s*$/gm)];
 const old=blocks(before).map(m=>m[1]);return blocks(after).filter(m=>!old.includes(m[1])).map(m=>({line:after.slice(0,m.index).split('\n').length,source:m[1]!}));
}
export async function extraChecks(task:TaskId,seed:Snapshot,candidate:Snapshot,directory:string,deadline=Infinity){
 const checks:any[]=[];if(!task.startsWith('V1-'))return {passed:true,checks};
 const blocks=changedJS(seed['readme.md'] ? contents(seed['readme.md']) : '',candidate['readme.md'] ? contents(candidate['readme.md']) : '');
 const files={...candidate};
 if(task==='V1-B')files['rc-edges.test.mjs']=file(readFileSync(join(ROOT,'evals/v1-rc-development/emittery-edges.mjs.fixture'),'utf8'));
 const r=await isolated(IMAGE,task,'quality-'+Date.now(),files);
 try{
  if(task==='V1-B'){
   if(Date.now()+60000>deadline)throw Error('附加检查窗口不足');
   const raw=await execute(r,['node','--test','--test-reporter=tap','--test-timeout=5000','rc-edges.test.mjs'],undefined,true,60000);assertVerificationCompleted(raw,'rc-edges');
   const result=parseTests(raw);checks.push({id:'OVERFLOW_ISOLATION',passed:result.exitCode===0&&result.total===3&&result.passed===3&&result.skipped===0&&result.cancelled===0,result});
  }
  for(const block of blocks){
   if(Date.now()+30000>deadline)throw Error('文档检查窗口不足');
   const result=await execute(r,['node','--input-type=module','--check'],block.source,true,30000);assertVerificationCompleted(result,'readme-syntax');checks.push({id:'README_JS:'+block.line,line:block.line,passed:result.exitCode===0,result});
  }
 }finally{await r.close()}
 const report={passed:checks.every(c=>c.passed),checks,method:'JS完整围栏只验证语法；文档语义与报告另行复核'};save(join(directory,'quality.json'),report);return report;
}
