import {join,relative} from 'node:path';
import {readFileSync} from 'node:fs';
import {save} from '../core.ts';
import {file,contents,taskFiles} from '../v1/tasks.ts';
import {digestBytes} from '../stable/profile.ts';
import {profile,revisionFor} from './profile.ts';
import {authorization,STUDY} from './config.ts';
import {reference} from './tasks.ts';
import {grade} from './grade.ts';
import type {ModuleId} from './modules.ts';
export async function runSentinels(modules:ModuleId[],directory=join(STUDY,'sentinel-'+Date.now())){
 const p=profile(),a=authorization(),deadline=Math.min(Date.now()+30*60000,a.workDeadline),rows=[];
 for(const module of modules){
  const task=module==='D'?'V1-D':module==='E'?'V1-E':'V1-U',positive=reference(task),negative=module==='Q'?taskFiles(task):structuredClone(positive);
  if(module==='E')negative['index.ts']=file(contents(negative['index.ts']!).replace('!hasSettled && registration.valid','!hasSettled'));
  if(module==='D')negative['index.js']=file(contents(negative['index.js']!).replace("options.signal?.removeEventListener('abort', onAbort);\n\t\t\tresolve({success, value});","// 资格负例：故意漏掉监听清理\n\t\t\tresolve({success, value});"));
  const cases=[];
  for(const [name,candidate,expected]of [['positive',positive,true],['negative',negative,false]]as const){
   if(Date.now()>=deadline)throw Error('哨兵超出定位窗口');
   const out=join(directory,module,name),r=await grade(task,'followup-sentinel-'+Date.now(),taskFiles(task),candidate,out,{regression:false,upstream:false,deadline:Math.min(Date.now()+900000,deadline)});
   const passed=r.codePassed===expected;cases.push({name,passed,code:r.codePassed,gradeFile:relative(STUDY,join(out,'grade.json')),gradeHash:digestBytes(readFileSync(join(out,'grade.json')))});if(!passed)throw Error('正反哨兵不符合预声明结果');
  }
  const reportPath=join(directory,module,'sentinel.json');save(reportPath,{module,cases,sourceHash:p.sourceHash,dependencyHash:revisionFor(p,task)});
  rows.push({module,positive:cases[0]!.passed,negative:cases[1]!.passed,report:relative(STUDY,reportPath),reportHash:digestBytes(readFileSync(reportPath)),dependencyHash:revisionFor(p,task)});
 }
 if(profile().sourceHash!==p.sourceHash)throw Error('哨兵期间源码改变');
 const report={complete:true,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,directory,rows,time:Date.now()};save(join(directory,'report.json'),report);return report;
}
if(import.meta.main){const modules=process.argv.slice(2);if(!modules.length||modules.some(m=>!['Q','D','E'].includes(m)))throw Error('需明确Q/D/E哨兵');console.log(JSON.stringify(await runSentinels(modules as ModuleId[])))}
