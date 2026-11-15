import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {save} from '../core.ts';
import {exclusive,verifyExecution} from '../stable/execution.ts';
import {STUDY,read,authorization} from './config.ts';
import {profile,revisionFor} from './profile.ts';
import {gradeInWorker} from './grading.ts';
import {beginRepair,completeRepair,setSlot} from './modules.ts';
import {moduleFor} from './dependency-scope.ts';
// 修复开始先消耗唯一机会；任何重评都只使用原执行封存，不调用模型。
export function startRecovery(id:string){
 const a=authorization(),p=profile(),path=join(STUDY,'attribution.json'),state=read(path);
 if(p.graderEpoch!==0||state.executionProfileHash!==p.executionProfileHash||state.oracleHash!==p.oracleHash)throw Error('修复前冻结身份不符');
 beginRepair(state,id,Date.now(),a.workDeadline);state.phase='grade_repair_required';state.gradeRecoveryUsed=true;
 exclusive(join(STUDY,'grade-recovery.claim'),{issue:id,startedAt:state.repair.startedAt,deadline:state.repair.deadline,priorRevisions:p.moduleGraderRevisions,executionProfileHash:p.executionProfileHash,contractHash:p.oracleHash});
 save(join(STUDY,'attribution-before-recovery.json'),state);save(path,state);return state;
}
export async function recoverScores(){
 const a=authorization(),p=profile(),state=read(join(STUDY,'attribution.json')),g=read(join(STUDY,'offline-gates.json')),claim=read(join(STUDY,'grade-recovery.claim'));
 if(state.phase!=='grade_repair_required'||!state.repair.used||p.graderEpoch!==1||Date.now()>=state.repair.deadline||p.executionProfileHash!==state.executionProfileHash||p.oracleHash!==state.oracleHash||!g.complete||g.sourceHash!==p.sourceHash)throw Error('不满足同契约恢复资格');
 const changed=(['Q','D','E']as const).filter(m=>claim.priorRevisions[m]!==p.moduleGraderRevisions[m]);
 if(!changed.length)throw Error('评分身份没有变化，不能重评重抽');
 const issue=state.issues.find((x:any)=>x.id===state.repair.issue);if(changed.some(m=>!issue.affected.includes(m)))throw Error('修复超出已声明影响范围');
 exclusive(join(STUDY,'grade-recovery-execution.claim'),{changed,deadline:state.repair.deadline});
 try{
  for(const row of state.rows.filter((r:any)=>changed.includes(moduleFor(r.execution.task)))){
   const run=row.execution.runDirectory,seal=verifyExecution(run,p.executionProfileHash);row.priorScores=[...(row.priorScores??[]),{score:row.score,checkpointScore:row.checkpointScore,manualReview:row.manualReview}];
   const deadline=Math.min(Date.now()+900000,a.workDeadline,state.repair.deadline),revision=revisionFor(p,seal.task),slot=state.slots.find((s:any)=>s.id===seal.id);
   if(slot.status!=='indeterminate'){slot.status='indeterminate';slot.reason='同契约评分恢复，原判定保留'}setSlot(state,seal.id,'grading',seal.artifactHash);
   row.score=await gradeInWorker(run,STUDY,revision,p.executionProfileHash,deadline);if(row.score.gradeStatus!=='complete')throw Error('统一恢复仍不可判定');
   if(existsSync(join(run,'review-checkpoint.json'))){row.checkpointScore=await gradeInWorker(run,STUDY,revision,p.executionProfileHash,deadline,'checkpoint');if(row.checkpointScore.gradeStatus!=='complete')throw Error('检查点恢复仍不可判定')}
   delete row.manualReview;row.fullDeliveryPassed=null;setSlot(state,seal.id,'manual_review_required',seal.artifactHash);save(join(STUDY,'attribution.json'),state);
  }
  completeRepair(state,state.repair.issue,Date.now(),{sameContract:true,sameExecution:true,qualified:true,allAffectedViewsRegraded:true});
  state.moduleGraderRevisions=p.moduleGraderRevisions;state.graderRevision=p.graderRevision;state.phase='manual_review_required';save(join(STUDY,'attribution.json'),state);return state;
 }catch(error){issue.state='paused';state.phase='incident_required';state.reason=String(error);save(join(STUDY,'attribution.json'),state);throw error}
}
if(import.meta.main){if(process.argv[2]==='--begin')console.log(JSON.stringify({started:startRecovery(process.argv[3]??'').repair}));else if(process.argv[2]==='--regrade')await recoverScores();else throw Error('需要--begin故障编号或--regrade')}
