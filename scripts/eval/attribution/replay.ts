import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {snapshotHash} from '../v1/tasks.ts';
import {grade} from './grade.ts';
import {capture,unchanged} from './provenance.ts';
import {STUDY,HISTORY,read,authorization} from './config.ts';
const a=authorization(),directory=join(STUDY,'historical-replay-'+Date.now()),p=capture(directory),rows:any[]=[];let complete=false;
const materials=read(join(HISTORY,'development.json')).rows;
save(join(directory,'declared.json'),{views:8,materials:materials.map((r:any)=>({id:r.execution.id,run:r.execution.runDirectory})),expectations:'原机判完整保留；新增WAITER只使current E最终增加失败。current E检查点无法构建，不将waiter运行失败解释成已定位该缺陷。'});
try{for(const item of materials){
 const x=item.execution,run=x.runDirectory,seal=verifyExecution(run),deadline=Math.min(Date.now()+900000,a.workDeadline),seed=read(join(run,'initial-files.json')),manifest=read(join(HISTORY,'tasks',x.task.slice(-1),'manifest.json'));
 for(const scope of ['final','checkpoint']as const){
  if(scope==='checkpoint'&&!existsSync(join(run,'review-checkpoint-files.json')))throw Error('缺少预声明检查点');
  unchanged(p);const candidate=read(join(run,scope==='final'?'final-files.json':'review-checkpoint-files.json'));
  const r=await grade(x.task,'attribution-replay-'+Date.now(),seed,candidate,join(directory,x.id+'-'+scope),{deadline,manifest,git:read(join(run,scope==='final'?'final-git.json':'review-checkpoint-git.json')),initialGit:read(join(run,'initial-git.json'))});
  verifyExecution(run);const prior=scope==='final'?item.score:item.checkpointScore,failures=r.checks.filter(c=>!c.pass).map(c=>c.id),existing=failures.filter(c=>c!=='WAITER');
  const waiter=r.checks.find(c=>c.id==='WAITER'),expectedWaiter=x.task==='V1-D'||item.product!=='current';
  const passed=r.codePassed===prior.codePassed&&r.regressionPassed===prior.regressionPassed&&JSON.stringify(existing)===JSON.stringify(prior.failureChecks)&&(x.task==='V1-D'||waiter?.pass===expectedWaiter);
  rows.push({id:x.id,scope,artifactHash:seal.artifactHash,viewHash:snapshotHash(candidate),priorOfficialScore:prior,code:r.codePassed,regression:r.regressionPassed,failures,waiter:waiter?.pass,passed});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({id:x.id,scope,passed,failures}));if(!passed)throw Error('历史回放与预先声明不符');
 }
}unchanged(p);complete=rows.length===8}finally{save(join(STUDY,'historical-replay-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows,meaning:'历史诊断资格，旧分数不回写，不计新样本'})}
