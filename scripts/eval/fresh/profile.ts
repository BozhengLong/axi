import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {fingerprint} from '../complex/fingerprint.ts';
import {digest,digestBytes} from '../stable/profile.ts';
import {taskFiles,taskManifest,snapshotHash,contents} from '../v1/tasks.ts';
import {ROOT} from '../core.ts';
import {STUDY,FRESH,IMAGE,tasks,schedule,read,preparationGate} from './settings.ts';
const executionFiles=new Set([
 'scripts/eval/core.ts','scripts/eval/adapters.ts','scripts/eval/trace.ts','scripts/eval/complex/fingerprint.ts',
 'scripts/eval/v1/adapter.ts','scripts/eval/v1/preview.ts','scripts/eval/v1/job.ts','scripts/eval/v1/runtime.ts','scripts/eval/v1/tasks.ts','scripts/eval/v1/settings.ts',
 'scripts/eval/c7/runtime.ts','scripts/eval/c7/tasks.ts','scripts/eval/c7/settings.ts','scripts/eval/c7/outcome.ts','scripts/eval/c6/runtime.ts','scripts/eval/c6/task.ts','scripts/eval/c6/settings.ts',
 'scripts/eval/stable/execution.ts','scripts/eval/review/config.ts','scripts/eval/fresh/settings.ts','scripts/eval/fresh/profile.ts','scripts/eval/fresh/run.ts','scripts/eval/fresh/recovery.ts','scripts/eval/fresh/control.ts','scripts/eval/fresh/gates.ts',
 'package.json','bun.lock','tsconfig.json','.dockerignore',
]);
export function profile(){
 const a=preparationGate(),all=fingerprint(),frozen=read(join(STUDY,'product-freeze.json'));
 const product=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')));if(digest(product)!==frozen.productHash)throw Error('新题阶段不能修改冻结产品或提示');
 const executionHashes=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')||p.startsWith('scripts/eval/container/')||executionFiles.has(p)));
 const oracle=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('evals/')||p.startsWith('tests/')||p==='docs/verification/2026-11-11-c7-source-review.json'));
 const grader=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('scripts/eval/')&&!(p in executionHashes)));
 const inputs=Object.fromEntries(tasks.map(task=>{const seed=taskFiles(task);if(contents(seed['eval/brief.md']!)!==readFileSync(join(ROOT,`evals/specs/v1-fresh-v1/${task.slice(-1)}/brief.md`),'utf8'))throw Error('公开题面与投递输入不符');return [task,snapshotHash(seed)]}));
 const dependencies=Object.fromEntries(tasks.flatMap(task=>['package-lock.json','dependencies.json','manifest.json'].map(name=>[task+'/'+name,digestBytes(readFileSync(join(STUDY,'tasks',task.slice(-1),name)))])));
 const epoch=existsSync(join(FRESH,'grader-epoch.json'))?read(join(FRESH,'grader-epoch.json')).epoch:0;if(![0,1].includes(epoch))throw Error('评分版本超限');
 const execution={image:IMAGE,productCommit:frozen.commit,productHash:frozen.productHash,oldProductCommit:'963704be97150e268edd3fda484d68e0a18a1f8b',node:'22.23.5',model:'claude-opus-5-5',effort:'medium',reviewMode:'auto',workRequests:40,reviewRequests:10,totalRequests:50,taskMs:1800000,gradeMs:900000,cpu:2,memoryGiB:4,dependencyCache:{'V1-D':{path:'/task/node_modules/.cache',tmpfsMiB:64}},inputs,dependencies,schedule,hashes:executionHashes};
 return {...all,execution,executionProfileHash:digest(execution),oracleHash:digest(oracle),graderRevision:digest({image:IMAGE,oracle,grader,epoch,version:'fresh-1'}),graderEpoch:epoch,authorization:a,dependencyVolumes:tasks.map(t=>taskManifest(t).dependencyVolume)};
}
