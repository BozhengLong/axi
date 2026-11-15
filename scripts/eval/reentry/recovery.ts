import {join} from 'node:path';
import {existsSync,renameSync} from 'node:fs';
import {save} from '../core.ts';
import {exclusive,verifyExecution} from '../stable/execution.ts';
import {STUDY,read,authorization} from './config.ts';
import {profile} from './profile.ts';
import {gradeInWorker} from './grading.ts';
export async function recoverDevelopment(){
 const a=authorization(),p=profile(),state=read(join(STUDY,'development.json')),g=read(join(STUDY,'offline-gates.json'));
 if(state.phase!=='grade_repair_required'||state.gradeRecoveryUsed||p.graderEpoch!==1||p.executionProfileHash!==state.executionProfileHash||p.oracleHash!==state.oracleHash||p.graderRevision===state.graderRevision||!g.complete||g.sourceHash!==p.sourceHash)throw Error('不满足唯一评分实现修复的条件');
 exclusive(join(STUDY,'grade-recovery.claim'),{time:new Date().toISOString(),prior:state.graderRevision,next:p.graderRevision,executionProfileHash:p.executionProfileHash,oracleHash:p.oracleHash});
 state.gradeRecoveryUsed=true;save(join(STUDY,'development-before-recovery.json'),state);
 // 恢复只允许同执行、同断言的统一重评分。旧分数保留，模型不重跑。
 if(existsSync(join(STUDY,'stop.json')))renameSync(join(STUDY,'stop.json'),join(STUDY,'stop-before-grade-recovery.json'));
 try{for(const row of state.rows){verifyExecution(row.execution.runDirectory,p.executionProfileHash);row.priorScores=[row.score,row.checkpointScore];const deadline=Math.min(Date.now()+900000,a.workDeadline);
  row.score=await gradeInWorker(row.execution.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline);
  if(row.score.gradeStatus!=='complete')throw Error('统一恢复仍不可判定');
  if(existsSync(join(row.execution.runDirectory,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(row.execution.runDirectory,STUDY,p.graderRevision,p.executionProfileHash,deadline,'checkpoint');if(row.checkpointScore.gradeStatus!=='complete')throw Error('检查点恢复仍不可判定')}
 }state.graderRevision=p.graderRevision;delete state.reason;save(join(STUDY,'development.json'),state);return state
 }catch(error){save(join(STUDY,'stop.json'),{state:'grading_blocked',reason:String(error),gradingAllowed:false,time:new Date().toISOString()});state.phase='stopped';state.reason=String(error);save(join(STUDY,'development.json'),state);throw error}
}
