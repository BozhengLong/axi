import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {save} from '../core.ts';
import {taskFiles,reference,file,contents} from '../v1/tasks.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {verifyExecution} from '../stable/execution.ts';
import {extraChecks,boundaries,boundaryCases} from './quality.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
const a=authorization(),directory=join(STUDY,'quality-calibration-'+Date.now()),frozen=fingerprint(),results:any[]=[];let complete=false;
async function run(id:string,task:'V1-A'|'V1-B',candidate:any,expected:boolean,requiredPrefix?:string){
 const r=await extraChecks(task,taskFiles(task),candidate,join(directory,id),a.workDeadline);
 const passed=r.passed===expected&&(!requiredPrefix||r.checks.some((c:any)=>!c.passed&&c.id.startsWith(requiredPrefix)));
 results.push({id,passed,actual:r.passed,checks:r.checks.length,failures:r.checks.filter((c:any)=>!c.passed).map((c:any)=>c.id)});console.log(JSON.stringify(results.at(-1)));if(!passed)throw Error('质量校准失败:'+id);
}
try{
 await run('A-reference','V1-A',reference('V1-A'),true);
 await run('B-reference','V1-B',reference('V1-B'),true);
 await run('B-baseline','V1-B',taskFiles('V1-B'),false);
 const provenance=read(join(STUDY,'input-provenance.json')),old=read(join(provenance.sourceStudy,'pilots.json')),stable=read(join(provenance.historicalStudy,'state.json'));
 for(const [x,prefix]of [[old.rows.find((x:any)=>x.execution.task==='V1-B').execution,'ASYNC:drop-'],[stable.executions.find((x:any)=>x.id==='formal-V1-B-r1-new'),'OVERFLOW_ISOLATION'],[stable.executions.find((x:any)=>x.id==='formal-V1-B-r1-old'),'README_JS:']]as const){verifyExecution(x.runDirectory);await run('known-'+x.id,'V1-B',read(join(x.runDirectory,'final-files.json')),false,prefix);verifyExecution(x.runDirectory)}
 const ref=reference('V1-B'),source=contents(ref['index.js']!);
 const variants=[
  ['no-observer','Promise.resolve(item).catch(() => {});',';','ASYNC:drop-'],
  ['swallow','waiter.reject);','() => waiter.resolve({done: true}));','ASYNC:pending-'],
  ['leak','signal?.removeEventListener(\'abort\', abort);',';','ASYNC:'],
  ['global-handler',"import {anyMap, producersMap, eventsMap} from './maps.js';","import {anyMap, producersMap, eventsMap} from './maps.js';\nprocess.on('unhandledRejection',()=>{});",'ASYNC:'],
 ];
 for(const [id,from,to,prefix]of variants){if(!source.includes(from!))throw Error('变体锚点缺失:'+id);await run('mutant-'+id,'V1-B',{...ref,'index.js':file(source.replace(from!,to!))},false,prefix)}
 complete=true;
}finally{const report={complete,finishedAt:new Date().toISOString(),image:IMAGE,sourceHash:frozen.sourceHash,directory,caseCount:boundaryCases.length,processChecksPerArtifact:boundaryCases.length*2,results};save(join(directory,'results.json'),report);save(join(STUDY,'quality-calibration-latest.json'),report)}
