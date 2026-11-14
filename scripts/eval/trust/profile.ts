import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {fingerprint} from '../complex/fingerprint.ts';
import {digest,digestBytes} from '../stable/profile.ts';
import {taskManifest,taskFiles,snapshotHash,contents} from '../v1/tasks.ts';
import {ROOT} from '../core.ts';
import {STUDY,IMAGE,tasks,read,authorization,developmentSchedule} from './config.ts';
const executionFiles=new Set([
 'scripts/eval/core.ts','scripts/eval/adapters.ts','scripts/eval/trace.ts','scripts/eval/complex/fingerprint.ts',
 'scripts/eval/v1/adapter.ts','scripts/eval/v1/preview.ts','scripts/eval/v1/job.ts','scripts/eval/v1/runtime.ts','scripts/eval/v1/tasks.ts','scripts/eval/v1/settings.ts',
 'scripts/eval/c7/runtime.ts','scripts/eval/c7/tasks.ts','scripts/eval/c7/settings.ts','scripts/eval/c7/outcome.ts','scripts/eval/c6/runtime.ts','scripts/eval/c6/task.ts','scripts/eval/c6/settings.ts','scripts/eval/stable/execution.ts',
 'scripts/eval/trust/versions.ts','scripts/eval/trust/resources.ts','scripts/eval/trust/config.ts','scripts/eval/trust/profile.ts','scripts/eval/trust/control.ts','scripts/eval/trust/run.ts','scripts/eval/trust/recovery.ts',
 'package.json','bun.lock','tsconfig.json','.dockerignore',
]);
export function profile(){
 const authorizationRecord=authorization(),all=fingerprint();
 const product=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')));
 const executionHashes=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')||p.startsWith('scripts/eval/container/')||executionFiles.has(p)));
 const oracle=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('evals/')||p==='docs/verification/2026-11-11-c7-source-review.json'));
 const grader=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('tests/')||p.startsWith('scripts/eval/')&&!(p in executionHashes)));
 const inputs=Object.fromEntries(tasks.map(task=>{const seed=taskFiles(task);if(contents(seed['eval/brief.md']!)!==readFileSync(join(ROOT,`evals/specs/v1-trust-dev-v1/${task.slice(-1)}/brief.md`),'utf8'))throw Error('开发题面与投递输入不符');return [task,{hash:snapshotHash(seed),manifest:taskManifest(task)}]}));
 const dependencies=Object.fromEntries(tasks.flatMap(task=>['package-lock.json','dependencies.json'].map(name=>[task+'/'+name,digestBytes(readFileSync(join(STUDY,'tasks',task.slice(-1),name)))])));
 const epoch=existsSync(join(STUDY,'grader-epoch.json'))?read(join(STUDY,'grader-epoch.json')).epoch:0;if(![0,1].includes(epoch))throw Error('评分版本超限');
 const execution={image:IMAGE,model:'claude-opus-5-5',effort:'medium',productHash:digest(product),currentV1Commit:authorizationRecord.baselineV1Commit,v0Commit:authorizationRecord.v0Commit,workRequests:40,reviewRequests:10,totalRequests:50,taskMs:1800000,gradeMs:900000,cpu:2,memoryGiB:4,inputs,dependencies,developmentSchedule,hashes:executionHashes};
 return {...all,execution,executionProfileHash:digest(execution),oracleHash:digest(oracle),graderRevision:digest({image:IMAGE,oracle,grader,epoch,version:'trust-1'}),graderEpoch:epoch,authorization:authorizationRecord};
}
