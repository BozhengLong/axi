import {join} from 'node:path';
import {save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {gradeInWorker,GradeInfrastructureError} from './grading.ts';
import {FRESH,read} from './settings.ts';
import {profile} from './profile.ts';
const p=profile(),pipeline=read(join(FRESH,'pipeline-latest.json'));if(!pipeline.complete||pipeline.executionProfileHash!==p.executionProfileHash)throw Error('先通过同执行版本的模拟');
const row=pipeline.results[0],run=row.execution.runDirectory,before=verifyExecution(run,p.executionProfileHash),results=[];
for(const stale of [false,true]){
 const target=join(FRESH,'fault-'+Date.now()+'-'+stale);
 if(stale)save(join(target,'grades',p.graderRevision,before.id,'score.json'),row.score);
 let indeterminate=false;try{await gradeInWorker(run,target,p.graderRevision,p.executionProfileHash,Date.now()-1)}catch(error){indeterminate=error instanceof GradeInfrastructureError}
 const unchanged=verifyExecution(run,p.executionProfileHash).artifactHash===before.artifactHash;results.push({stale,passed:indeterminate&&unchanged,indeterminate,artifactUnchanged:unchanged});
}
const complete=results.every(r=>r.passed);save(join(FRESH,'grader-fault-check.json'),{complete,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,results});console.log(JSON.stringify({complete,results}));if(!complete)throw Error('评分故障检查未通过');
