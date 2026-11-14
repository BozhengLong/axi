import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {grade} from './grade.ts';
import {capture,unchanged} from './provenance.ts';
import {STUDY,HISTORY,read,authorization,type DevTask} from './config.ts';
const a=authorization(),directory=join(STUDY,'historical-replay-'+Date.now()),p=capture(directory),state=read(join(HISTORY,'fresh/state.json')),rows:any[]=[];let complete=false;
try{
 for(const item of state.rows){
  const x=item.execution,run=x.runDirectory,seal=verifyExecution(run),task=x.task as DevTask;
  const deadline=Math.min(Date.now()+900000,a.workDeadline),seed=read(join(run,'initial-files.json')),manifest=read(join(HISTORY,'tasks',task.slice(-1),'manifest.json'));
  for(const scope of ['final','checkpoint']){
   if(scope==='checkpoint'&&!existsSync(join(run,'review-checkpoint-files.json')))continue;
   unchanged(p);const candidate=read(join(run,scope==='final'?'final-files.json':'review-checkpoint-files.json'));
   const r=await grade(task,'trust-replay-'+Date.now(),seed,candidate,join(directory,x.id+'-'+scope),{deadline,manifest,git:read(join(run,scope==='final'?'final-git.json':'review-checkpoint-git.json')),initialGit:read(join(run,'initial-git.json'))});
   verifyExecution(run);const contract=r.logs.contract as any;
   const targets=task==='V1-E'?['E21']:(x.variant==='new'?['D20']:['D08','D20']);
   const expectedTargets=targets.every(t=>new RegExp('not ok \\d+ - '+t+' ').test(contract.stdout));
   const row={id:x.id,scope,artifactHash:seal.artifactHash,priorOfficialScore:(scope==='final'?item.score:item.checkpointScore)??null,contractVersion:'trust-development-v1',code:r.codePassed,regression:r.regressionPassed,failedChecks:r.checks.filter(c=>!c.pass).map(c=>c.id),targets,expectedTargets,regressionOld:r.testReplay.previous?{total:r.testReplay.previous.total,passed:r.testReplay.previous.passed,failed:r.testReplay.previous.failed,cancelled:r.testReplay.previous.cancelled,durationMs:r.testReplay.previous.durationMs}:null,passed:!r.codePassed&&r.regressionPassed&&expectedTargets};
   rows.push(row);save(join(directory,'rows.json'),rows);console.log(JSON.stringify(row));if(!row.passed)throw Error('历史回放与已确认缺陷或回归有效性不符');
  }
 }
 unchanged(p);complete=rows.length===8;
}finally{save(join(STUDY,'historical-replay-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows,meaning:'新契约下的离线资格检查；不回写历史成绩，不计新模型成功'})}
