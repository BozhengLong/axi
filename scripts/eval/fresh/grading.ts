import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {command,save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {read} from './settings.ts';
import {profile} from './profile.ts';
export class GradeInfrastructureError extends Error {}
export async function gradeInWorker(run:string,target:string,revision:string,executionProfileHash:string,deadline:number,scope:'final'|'checkpoint'='final'){
 const p=profile();if(p.executionProfileHash!==executionProfileHash||p.graderRevision!==revision)throw Error('冻结版本发生改变');
 const seal=verifyExecution(run,executionProfileHash),path=join(target,'grades',revision,seal.id+(scope==='checkpoint'?'-checkpoint':''),'score.json');
 const result=await command(['bun','scripts/eval/fresh/grade-one.ts','--offline'],JSON.stringify({run,target,revision,executionProfileHash,deadline:Math.min(Date.now()+15*60000,deadline),scope}),true,Math.max(1,Math.min(15*60000,deadline-Date.now())));
 if(result.exitCode||result.timedOut||!existsSync(path)){save(join(target,seal.id+'-worker-failure.json'),result);throw new GradeInfrastructureError('独立评分进程未完成，不能采用旧分数')}
 const score=read(path);verifyExecution(run,executionProfileHash);const now=profile();if(now.executionProfileHash!==executionProfileHash||now.graderRevision!==revision)throw Error('评分期间版本改变');
 if(score.artifactHash!==seal.artifactHash||score.graderRevision!==revision||score.scope!==scope)throw Error('分数身份不符');return score;
}
