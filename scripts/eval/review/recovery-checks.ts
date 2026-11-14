import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {STUDY,read} from './config.ts';
import {profile} from './profile.ts';
import {gradeInWorker,GradeInfrastructureError} from './grading.ts';
const p=profile(),pipeline=read(join(STUDY,'pipeline-latest.json'));
if(!pipeline.complete||pipeline.executionProfileHash!==p.executionProfileHash)throw Error('缺少同执行版本的模拟封存产物');
const run=pipeline.results[0].execution.runDirectory,seal=verifyExecution(run,p.executionProfileHash),target=join(STUDY,'grader-fault-'+Date.now()),results:any[]=[];
for(const stale of [false,true]){
 const dest=join(target,stale?'stale':'empty');
 if(stale){const d=join(dest,'grades',p.graderRevision,seal.id);mkdirSync(d,{recursive:true,mode:0o700});save(join(d,'score.json'),{artifactHash:seal.artifactHash,graderRevision:p.graderRevision,gradeStatus:'complete',codePassed:true})}
 let classified=false;try{await gradeInWorker(run,dest,p.graderRevision,p.executionProfileHash,Date.now()-1)}catch(error){classified=error instanceof GradeInfrastructureError}
 const unchanged=verifyExecution(run,p.executionProfileHash).artifactHash===seal.artifactHash;
 results.push({stale,passed:classified&&unchanged,failureClassifiedIndeterminate:classified,artifactUnchanged:unchanged});
}
const complete=results.every(r=>r.passed),report={complete,image:p.execution.image,sourceHash:p.sourceHash,artifactHash:seal.artifactHash,failureClassifiedIndeterminate:complete,artifactUnchanged:complete,results,directory:target};
save(join(STUDY,'grader-fault-check.json'),report);console.log(JSON.stringify({complete,results}));if(!complete)process.exitCode=1;
