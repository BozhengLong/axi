import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {fingerprint} from '../complex/fingerprint.ts';
import {digest,digestBytes} from '../stable/profile.ts';
import {taskFiles,snapshotHash} from '../v1/tasks.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
const executionFiles=new Set([
 'scripts/eval/core.ts','scripts/eval/adapters.ts','scripts/eval/trace.ts','scripts/eval/complex/fingerprint.ts',
 'scripts/eval/v1/adapter.ts','scripts/eval/v1/preview.ts','scripts/eval/v1/job.ts','scripts/eval/v1/runtime.ts','scripts/eval/v1/tasks.ts','scripts/eval/v1/settings.ts',
 'scripts/eval/c7/runtime.ts','scripts/eval/c7/tasks.ts','scripts/eval/c7/settings.ts','scripts/eval/c7/outcome.ts','scripts/eval/c6/runtime.ts','scripts/eval/c6/task.ts','scripts/eval/c6/settings.ts',
 'scripts/eval/stable/execution.ts','scripts/eval/review/config.ts','scripts/eval/review/profile.ts','scripts/eval/review/run.ts','scripts/eval/review/recovery.ts',
 'package.json','bun.lock','tsconfig.json','.dockerignore',
]);
export function splitHashes(hashes:Record<string,string>){
 const entries=Object.entries(hashes);
 const execution=Object.fromEntries(entries.filter(([p])=>p.startsWith('src/')||p.startsWith('scripts/eval/container/')||executionFiles.has(p)));
 const oracle=Object.fromEntries(entries.filter(([p])=>p.startsWith('evals/')||p.startsWith('tests/')||p==='docs/verification/2026-11-11-c7-source-review.json'));
 const grader=Object.fromEntries(entries.filter(([p])=>p.startsWith('scripts/eval/')&&!(p in execution)));
 return {execution,oracle,grader};
}
export function profile(){
 const a=authorization(),all=fingerprint(),origin=read(join(STUDY,'product-freeze.json'));
 const actual=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')));
 if(digest(actual)!==origin.productHash)throw Error('候选产品或系统指令已改变');
 const inputs=Object.fromEntries((['V1-A','V1-B','C7-L','C7-O']as const).map(t=>[t,snapshotHash(taskFiles(t))]));
 const hashes=splitHashes(all.hashes),dependencies=Object.fromEntries(['A','B'].flatMap(id=>['package-lock.json','dependencies.json','manifest.json'].map(file=>[id+'/'+file,digestBytes(readFileSync(join(STUDY,'tasks',id,file)))])));
 const epochFile=join(STUDY,'grader-epoch.json'),graderEpoch=existsSync(epochFile)?read(epochFile).epoch:0;if(![0,1].includes(graderEpoch))throw Error('评分恢复版本超限');
 const execution={image:IMAGE,productCommit:origin.commit,productHash:origin.productHash,node:'22.23.5',model:'claude-opus-5-5',effort:'medium',inputs,dependencies,cpu:2,memoryGiB:4,runMs:1800000,generationRequests:50,reviewPolicy:{autoWork:40,review:10,offTotal:50,schedule:['V1-A:off','V1-A:auto','V1-B:auto','V1-B:off']},hashes:hashes.execution};
 return {...all,graderEpoch,execution,executionProfileHash:digest(execution),oracleHash:digest(hashes.oracle),graderRevision:digest({image:IMAGE,oracle:hashes.oracle,grader:hashes.grader,graderVersion:'review-development-1',graderEpoch}),authorization:a};
}
