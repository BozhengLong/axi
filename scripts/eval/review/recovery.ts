import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {save} from '../core.ts';
import {verifyExecution,exclusive} from '../stable/execution.ts';
import {STUDY,read,authorization} from './config.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
// 只有评分实现可以修复；所有执行产物和保留断言必须仍是同一版本。
export async function recoverGrades(kind:string){
 const a=authorization(),p=profile(),current=read(join(STUDY,kind+'.json')),approval=read(join(STUDY,'grader-repair.json'));
 if(p.graderEpoch!==1||current.phase!=='grade_repair_required'||current.executionProfileHash!==p.executionProfileHash||current.oracleHash!==p.oracleHash||current.graderRevision===p.graderRevision||approval.previousRevision!==current.graderRevision||approval.newRevision!==p.graderRevision||approval.reviewedBy!=='current-assistant'||approval.semanticsUnchanged!==true)throw Error('评分修复身份或语义不符');
 for(const name of ['calibration-latest.json','quality-calibration-latest.json']){const r=read(join(STUDY,name));if(!r.complete||r.sourceHash!==p.sourceHash||r.results.some((x:any)=>!x.passed))throw Error('修复后校准未通过')}
 const fault=read(join(STUDY,'grader-fault-check.json'));if(!fault.complete||fault.sourceHash!==p.sourceHash||fault.artifactUnchanged!==true||fault.failureClassifiedIndeterminate!==true)throw Error('评分故障注入未通过');
 const states=['development','c7'].filter(k=>existsSync(join(STUDY,k+'.json'))).map(k=>({kind:k,state:read(join(STUDY,k+'.json'))}));
 const count=states.reduce((n,x)=>n+x.state.rows.length,0);if(Date.now()+count*15*60000>a.workDeadline)throw Error('统一重评窗口不足');
 for(const {state}of states)for(const row of state.rows)verifyExecution(row.execution.runDirectory,p.executionProfileHash);
 exclusive(join(STUDY,'grade-recovery.claim'),{time:new Date().toISOString(),previous:current.graderRevision,next:p.graderRevision,artifacts:count});
 for(const {kind,state}of states){
  state.previousGraderRevision=state.graderRevision;state.graderRevision=p.graderRevision;state.gradeRecoveryUsed=true;
  for(const row of state.rows){const deadline=Math.min(Date.now()+15*60000,a.workDeadline);row.score=await gradeInWorker(row.execution.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline);if(row.score.gradeStatus!=='complete')throw Error('评分恢复仍不可判定');if(existsSync(join(row.execution.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(row.execution.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');if(row.checkpointScore.gradeStatus!=='complete')throw Error('检查点恢复仍不可判定')}save(join(STUDY,kind+'.json'),state)}
 }
 return read(join(STUDY,kind+'.json'));
}
