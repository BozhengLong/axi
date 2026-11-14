import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {command,save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {read} from './config.ts';
export async function gradeInWorker(run:string,target:string,revision:string,executionProfileHash:string,deadline:number){
 const seal=verifyExecution(run,executionProfileHash),scorePath=join(target,'grades',revision,seal.id,'score.json');
 const result=await command(['bun','scripts/eval/rc/grade-one.ts','--offline'],JSON.stringify({run,target,revision,executionProfileHash,deadline:Math.min(Date.now()+15*60000,deadline)}),true,15*60000);
 if(result.exitCode||result.timedOut||!existsSync(scorePath)){save(join(target,seal.id+'-worker-failure.json'),result);throw Error('评分设施异常，保留执行等待统一诊断')}
 const score=read(scorePath);verifyExecution(run,executionProfileHash);
 if(score.artifactHash!==seal.artifactHash||score.graderRevision!==revision)throw Error('评分产物身份不符');return score;
}
