import{expect,test}from'bun:test';
import{recoveryDecision,nextAfterGrade,regradeAll,type RecoveryContext}from'./recovery.ts';
const good:RecoveryContext={used:false,executionMatches:true,oracleMatches:true,evidenceComplete:true,semanticsReviewed:true,calibrationPassed:true,faultChecksPassed:true,remainingMs:18*3600000,completed:3};
test('评分恢复拒绝执行变化、规则变化、证据缺口、重复恢复和不足窗口',()=>{
 expect(recoveryDecision(good).allowed).toBe(true);
 for(const change of [{used:true},{executionMatches:false},{oracleMatches:false},{evidenceComplete:false},{semanticsReviewed:false},{calibrationPassed:false},{faultChecksPassed:false},{remainingMs:60000}])expect(recoveryDecision({...good,...change}).allowed).toBe(false);
});
test('普通断言失败完成评分，不触发补跑；统一重评包含此前通过和失败样本',async()=>{
 expect(nextAfterGrade('complete',false)).toBe('continue');expect(nextAfterGrade('indeterminate',false)).toBe('grade_repair_required');expect(nextAfterGrade('indeterminate',true)).toBe('stop');
 const seen:number[]=[],saved:number[]=[];const scores=await regradeAll([1,2,3],async id=>{seen.push(id);return{gradeStatus:'complete',codePassed:id!==2}},id=>saved.push(id));
 expect(seen).toEqual([1,2,3]);expect(saved).toEqual([1,2,3]);expect(scores[1].codePassed).toBe(false);
});
test('重评再次不可判定时留存失败并停止，不跳过失败后继续凑结果',async()=>{
 const saved:number[]=[];await expect(regradeAll([1,2,3],async id=>({gradeStatus:id===2?'indeterminate':'complete'}),id=>saved.push(id))).rejects.toThrow('grade_recovery_failed');expect(saved).toEqual([1,2]);
});
