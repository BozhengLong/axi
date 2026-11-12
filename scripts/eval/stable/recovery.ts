export type RecoveryContext={used:boolean;executionMatches:boolean;oracleMatches:boolean;evidenceComplete:boolean;semanticsReviewed:boolean;calibrationPassed:boolean;faultChecksPassed:boolean;remainingMs:number;completed:number};
export function recoveryDecision(x:RecoveryContext){
 if(x.used)return {allowed:false,reason:'grade_recovery_limit'};
 if(!x.executionMatches)return {allowed:false,reason:'execution_profile_changed'};
 if(!x.oracleMatches||!x.semanticsReviewed)return {allowed:false,reason:'grading_rules_changed_or_unreviewed'};
 if(!x.evidenceComplete)return {allowed:false,reason:'evidence_incomplete'};
 if(!x.calibrationPassed||!x.faultChecksPassed)return {allowed:false,reason:'repair_not_validated'};
 if(x.remainingMs<(x.completed*15+30)*60000)return {allowed:false,reason:'insufficient_regrade_window'};
 return {allowed:true,reason:'grade_only_recovery'};
}
export function nextAfterGrade(status:'complete'|'indeterminate',used:boolean){return status==='complete'?'continue':used?'stop':'grade_repair_required'}

// 只接收既有产物与评分回调；本层不具有启动模型的入口。
export async function regradeAll<T>(items:T[],grade:(x:T)=>Promise<any>,persist:(x:T,score:any)=>void){
 const scores=[];for(const item of items){const score=await grade(item);persist(item,score);scores.push(score);if(score.gradeStatus!=='complete')throw Error('grade_recovery_failed')}return scores;
}
