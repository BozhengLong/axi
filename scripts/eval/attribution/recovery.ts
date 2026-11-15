import {join} from 'node:path';
import {existsSync,renameSync} from 'node:fs';
import {save} from '../core.ts';
import {exclusive,verifyExecution} from '../stable/execution.ts';
import {STUDY,read,authorization} from './config.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
// 同一执行封存统一重评；此入口绝不启动模型，也不恢复被中断的任务槽。
export async function recoverScores(){
 const a=authorization(),p=profile(),state=read(join(STUDY,'attribution.json')),g=read(join(STUDY,'offline-gates.json'));
 if(state.phase!=='grade_repair_required'||state.gradeRecoveryUsed||p.graderEpoch!==1||p.executionProfileHash!==state.executionProfileHash||p.oracleHash!==state.oracleHash||p.graderRevision===state.graderRevision||!g.complete||g.sourceHash!==p.sourceHash)throw Error('不满足唯一评分修复的条件');
 exclusive(join(STUDY,'grade-recovery.claim'),{time:new Date().toISOString(),prior:state.graderRevision,next:p.graderRevision,executionProfileHash:p.executionProfileHash});
 state.gradeRecoveryUsed=true;save(join(STUDY,'attribution-before-recovery.json'),state);
 if(existsSync(join(STUDY,'stop.json')))renameSync(join(STUDY,'stop.json'),join(STUDY,'stop-before-grade-recovery.json'));
 try{for(const row of state.rows){
  verifyExecution(row.execution.runDirectory,p.executionProfileHash);row.priorScores=[row.score,row.checkpointScore];const deadline=Math.min(Date.now()+900000,a.workDeadline);
  row.score=await gradeInWorker(row.execution.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline);
  if(row.score.gradeStatus!=='complete')throw Error('统一恢复仍不可判定');
  if(existsSync(join(row.execution.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(row.execution.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');if(row.checkpointScore.gradeStatus!=='complete')throw Error('检查点恢复仍不可判定')}
 }state.graderRevision=p.graderRevision;state.phase='manual_review_required';delete state.reason;save(join(STUDY,'attribution.json'),state);return state;
 }catch(error){save(join(STUDY,'stop.json'),{state:'grading_blocked',reason:String(error),gradingAllowed:false,time:new Date().toISOString()});state.phase='stopped';state.reason=String(error);save(join(STUDY,'attribution.json'),state);throw error}
}
if(import.meta.main){if(process.argv[2]!=='--regrade')throw Error('需要 --regrade');await recoverScores()}
