import{createHash}from'node:crypto';
import{join}from'node:path';
import{existsSync,readFileSync}from'node:fs';
import{fingerprint}from'../complex/fingerprint.ts';
import{taskFiles,snapshotHash}from'../v1/tasks.ts';
import{schedule}from'../v1/settings.ts';
import{authorization,STUDY,IMAGE,read}from'./config.ts';
export const digestBytes=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
export const digest=(x:unknown)=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const executable=new Set(['scripts/eval/core.ts','scripts/eval/adapters.ts','scripts/eval/trace.ts','scripts/eval/v1/adapter.ts','scripts/eval/v1/preview.ts','scripts/eval/v1/transport.ts','scripts/eval/v1/job.ts','scripts/eval/v1/runtime.ts','scripts/eval/v1/tasks.ts','scripts/eval/v1/settings.ts','scripts/eval/c7/runtime.ts','scripts/eval/c7/tasks.ts','scripts/eval/c7/settings.ts','scripts/eval/c7/outcome.ts','scripts/eval/c6/runtime.ts','scripts/eval/c6/task.ts','scripts/eval/c6/settings.ts','scripts/eval/stable/config.ts','scripts/eval/stable/profile.ts','scripts/eval/stable/execution.ts','scripts/eval/stable/run.ts','scripts/eval/stable/recovery.ts']);
export function profile(){
 const a=authorization(),all=fingerprint(),origin=read(join(STUDY,'product-origin-freeze.json'));
 for(const[p,h]of Object.entries(origin.runtimeHashes))if(p.startsWith('src/')&&all.hashes[p]!==h)throw Error('产品冻结后发生改变:'+p);
 const executionHashes=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')||p.startsWith('scripts/eval/container/')||executable.has(p)||['package.json','bun.lock','tsconfig.json','.dockerignore'].includes(p)));
 const oracleHashes=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('evals/')||p.startsWith('tests/')||p==='docs/verification/2026-11-11-c7-source-review.json'));
 const inputs=Object.fromEntries((['V1-A','V1-B']as const).map(t=>[t,snapshotHash(taskFiles(t))]));
 const dependencyHashes=Object.fromEntries(['A','B'].flatMap(id=>['package-lock.json','dependencies.json','manifest.json'].map(file=>[id+'/'+file,digestBytes(readFileSync(join(STUDY,'tasks',id,file)))])));
 const execution={dependencyHashes,image:IMAGE,node:'22.23.5',nodeProfile:process.env.AXI_V1_NODE_PROFILE,model:'claude-opus-5-5',effort:'medium',productCommit:a.productCommit,inputs,schedule,cpu:2,memoryGiB:4,runMs:1800000,generationRequests:50,hashes:executionHashes};
 const graderHashes=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('scripts/eval/')&&!executable.has(p)&&!p.startsWith('scripts/eval/container/')));
 const epochPath=join(STUDY,'grader-epoch.json'),graderEpoch=existsSync(epochPath)?read(epochPath).epoch:0;
 if(!Number.isInteger(graderEpoch)||graderEpoch<0||graderEpoch>1)throw Error('评分版本阶段无效');
 return {...all,inputs,graderEpoch,execution,executionProfileHash:digest(execution),oracleHash:digest(oracleHashes),graderRevision:digest({epoch:graderEpoch,image:IMAGE,nodeArguments:['node'],graderHashes,oracleHashes})};
}
