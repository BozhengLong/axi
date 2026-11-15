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
 'scripts/eval/reentry/versions.ts','scripts/eval/reentry/resources.ts','scripts/eval/reentry/config.ts','scripts/eval/reentry/profile.ts','scripts/eval/reentry/control.ts','scripts/eval/reentry/run.ts','scripts/eval/reentry/recovery.ts',
 'package.json','bun.lock','tsconfig.json','.dockerignore',
]);
export function profile(){
 const authorizationRecord=authorization(),all=fingerprint();
 const product=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')));
 const executionHashes=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')||p.startsWith('scripts/eval/container/')||executionFiles.has(p)));
 const measurementFiles=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('evals/')||p==='docs/verification/2026-11-11-c7-source-review.json'));
 const oracle=JSON.parse(readFileSync(join(ROOT,'evals/specs/v1-reentry-dev-v1/contract-decision.json'),'utf8'));
 if(oracle.version!==1)throw Error('契约判定清单版本无效');
 const grader=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('tests/')||p.startsWith('scripts/eval/')&&!(p in executionHashes)));
 const inputs=Object.fromEntries(tasks.map(task=>{const seed=taskFiles(task);if(contents(seed['eval/brief.md']!)!==readFileSync(join(ROOT,`evals/specs/v1-reentry-dev-v1/${task.slice(-1)}/brief.md`),'utf8'))throw Error('开发题面与投递输入不符');return [task,{hash:snapshotHash(seed),manifest:taskManifest(task)}]}));
 const dependencies=Object.fromEntries(tasks.flatMap(task=>['package-lock.json','dependencies.json'].map(name=>[task+'/'+name,digestBytes(readFileSync(join(STUDY,'tasks',task.slice(-1),name)))])));
 const epoch=existsSync(join(STUDY,'grader-epoch.json'))?read(join(STUDY,'grader-epoch.json')).epoch:0;if(![0,1].includes(epoch))throw Error('评分版本超限');
 const repair=epoch===1?read(join(STUDY,'grade-repair-decision.json')):undefined;
 if(repair&&(repair.contractDecisionHash!==digest(oracle)||repair.executionChanged!==false||repair.contractChanged!==false||!repair.reproduction||!repair.positiveControl||!repair.negativeControl))throw Error('评分修复缺少同契约依据');
 for(const [path,definition]of Object.entries(oracle.definitions) as [string,any][]){
  const actual=digestBytes(readFileSync(join(ROOT,path)));
  if(actual===definition.sha256AtDefinition)continue;
  if(epoch!==1||!path.startsWith('evals/v1-reentry-dev-v1/oracle/')||repair?.measurementChanges?.[path]?.prior!==definition.sha256AtDefinition||repair?.measurementChanges?.[path]?.next!==actual)throw Error('契约定义或未声明测量脚本发生变化:'+path);
 }
 const execution={image:IMAGE,model:'claude-opus-5-5',effort:'medium',productHash:digest(product),currentV1Commit:authorizationRecord.baselineV1Commit,v0Commit:authorizationRecord.v0Commit,workRequests:40,reviewRequests:10,totalRequests:50,taskMs:1800000,gradeMs:900000,cpu:2,memoryGiB:4,inputs,dependencies,developmentSchedule,hashes:executionHashes};
 return {...all,execution,executionProfileHash:digest(execution),oracleHash:digest(oracle),contractDecisionHash:digest(oracle),measurementHash:digest(measurementFiles),measurementFiles,graderRevision:digest({image:IMAGE,oracle,measurementFiles,grader,epoch,version:'reentry-1'}),graderEpoch:epoch,authorization:authorizationRecord};
}
