import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {save} from '../core.ts';
import {exclusive,verifyExecution} from '../stable/execution.ts';
import {FRESH,STUDY,read,authorization} from './settings.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
export async function recoverGrades(){
 const a=authorization(),p=profile(),state=read(join(FRESH,'state.json')),approval=read(join(FRESH,'grader-repair.json'));
 if(existsSync(join(STUDY,'grade-recovery.claim'))||state.phase!=='grade_repair_required'||p.graderEpoch!==1||state.executionProfileHash!==p.executionProfileHash||state.oracleHash!==p.oracleHash||state.graderRevision===p.graderRevision||approval.previousRevision!==state.graderRevision||approval.newRevision!==p.graderRevision||approval.semanticsUnchanged!==true||approval.reviewedBy!=='current-assistant')throw Error('评分恢复身份、额度或语义不符');
 for(const name of ['calibration-latest.json','grader-fault-check.json']){const r=read(join(FRESH,name));if(!r.complete||r.sourceHash!==p.sourceHash)throw Error('修复后校准与故障注入未通过')}
 for(const row of state.rows)verifyExecution(row.execution.runDirectory,p.executionProfileHash);
 const scored=state.rows.filter((r:any)=>['completed','candidate_unfinished'].includes(r.execution.classification));if(Date.now()+scored.length*15*60000>a.workDeadline)throw Error('统一重评窗口不足');
 exclusive(join(STUDY,'grade-recovery.claim'),{stage:'fresh',time:new Date().toISOString(),previous:state.graderRevision,next:p.graderRevision,artifacts:scored.length});
 state.previousGraderRevision=state.graderRevision;state.previousScores=state.rows.map((r:any)=>({id:r.execution.id,score:r.score,checkpointScore:r.checkpointScore}));state.graderRevision=p.graderRevision;state.gradeRecoveryUsed=true;state.phase='regrading';save(join(FRESH,'state.json'),state);
 try{
  for(const row of scored){const deadline=Math.min(Date.now()+15*60000,a.workDeadline);row.score=await gradeInWorker(row.execution.runDirectory,FRESH,p.graderRevision,p.executionProfileHash,deadline);if(row.score.gradeStatus!=='complete')throw Error('重评仍不可判定');
   if(existsSync(join(row.execution.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(row.execution.runDirectory,FRESH,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');if(row.checkpointScore.gradeStatus!=='complete')throw Error('检查点重评仍不可判定')}
   save(join(FRESH,'state.json'),state);
  }
 }catch(error){state.phase='stopped';state.stopReason=String(error);save(join(FRESH,'state.json'),state);throw error}
 return state;
}
