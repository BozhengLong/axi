import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {command,save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {read} from './config.ts';
import {profile} from './profile.ts';
export class GradeInfrastructureError extends Error {}
export async function gradeInWorker(run:string,target:string,revision:string,executionProfileHash:string,deadline:number,scope:"final"|"checkpoint"="final"){
 const current=profile();if(current.executionProfileHash!==executionProfileHash||current.graderRevision!==revision)throw Error('冻结版本发生改变');
 const seal=verifyExecution(run,executionProfileHash),scorePath=join(target,'grades',revision,seal.id+(scope==='checkpoint'?'-checkpoint':''),'score.json');
 const result=await command(['bun','scripts/eval/review/grade-one.ts','--offline'],JSON.stringify({run,target,revision,executionProfileHash,scope,deadline:Math.min(Date.now()+15*60000,deadline)}),true,Math.max(1,Math.min(15*60000,deadline-Date.now())));
 if(result.exitCode||result.timedOut||!existsSync(scorePath)){save(join(target,seal.id+'-worker-failure.json'),result);throw new GradeInfrastructureError('评分设施异常，保留执行等待统一诊断')}
 const score=read(scorePath);if(profile().executionProfileHash!==executionProfileHash||profile().graderRevision!==revision)throw Error('评分期间冻结版本改变');verifyExecution(run,executionProfileHash);
 if(score.artifactHash!==seal.artifactHash||score.graderRevision!==revision)throw Error('评分产物身份不符');return score;
}
