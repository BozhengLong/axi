import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {ROOT,execute,save,type Snapshot} from '../core.ts';
import {file} from '../v1/tasks.ts';
import {isolated} from '../v1/runtime.ts';
import {assertVerificationCompleted} from '../v1/verification-status.ts';
import {extraChecks as previousChecks} from '../rc/quality.ts';
import type {TaskId} from '../v1/settings.ts';
import {IMAGE} from '../v1/settings.ts';
export const boundaryCases=[
 ...['drop-oldest','drop-newest','error'].flatMap(s=>['plain','resolved','rejected','then-reject','then-getter'].map(k=>[s,k])),
 ...['consume-events','consume-any','pending-events','pending-any'].flatMap(s=>['rejected','then-getter'].map(k=>[s,k])),
 ...['abort','return','clear'].flatMap(s=>['rejected','then-getter'].map(k=>[s,k])),
];
export async function boundaries(task:TaskId,candidate:Snapshot,directory:string,deadline=Infinity){
 if(task!=='V1-B')return {passed:true,checks:[]};
 const r=await isolated(IMAGE,task,'boundaries-'+Date.now(),{...candidate,'review-boundaries.mjs':file(readFileSync(join(ROOT,'evals/v1-review-development/async-boundaries.mjs.fixture'),'utf8'))});const checks:any[]=[];
 try{for(const [scenario,kind]of boundaryCases)for(const mode of ['observe','plain']){
  if(Date.now()+10000>deadline)throw Error('边界检查截止不足');
  const x=await execute(r,['node','review-boundaries.mjs',scenario!,kind!,mode],undefined,true,10000);assertVerificationCompleted(x,'review-boundary');let marker:any;try{marker=JSON.parse(x.stdout.trim())}catch{}
  const passed=x.exitCode===0&&marker?.passed===true&&marker.scenario===scenario&&marker.kind===kind&&marker.mode===mode;
  checks.push({id:`ASYNC:${scenario}:${kind}:${mode}`,passed,result:x});
 }}finally{await r.close()}
 const result={passed:checks.every(c=>c.passed),checks};save(join(directory,'boundaries.json'),result);return result;
}
export async function extraChecks(task:TaskId,seed:Snapshot,candidate:Snapshot,directory:string,deadline=Infinity){
 const prior=await previousChecks(task,seed,candidate,join(directory,'existing'),deadline),next=await boundaries(task,candidate,join(directory,'async'),deadline);
 const result={passed:prior.passed&&next.passed,checks:[...prior.checks,...next.checks]};save(join(directory,'quality.json'),result);return result;
}
