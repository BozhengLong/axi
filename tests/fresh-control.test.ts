import {test,expect} from 'bun:test';
import {disposition,groupDecision} from '../scripts/eval/fresh/control.ts';
test('普通未完成与交付失败不获得新抽样，只有已分类上游故障可恢复整组',()=>{
 const done={classification:'completed'},unfinished={classification:'candidate_unfinished'},upstream={classification:'environment_indeterminate'};
 expect(groupDecision([done,unfinished,done],false,10*3600000)).toBe('adopt');
 expect(groupDecision([done,upstream,done],false,146*60000)).toBe('retry_whole_group');
 expect(groupDecision([done,upstream,done],false,146*60000-1)).toBe('stop_time');
 expect(groupDecision([done,upstream,done],true,10*3600000)).toBe('stop_recovery_used');
 expect(groupDecision([done,done],false,10*3600000)).toBe('stop_incomplete');
});
test('鉴权、未知协议及证据/设施故障不能用上游恢复额度',()=>{
 const done={classification:'completed'};
 for(const classification of ['authentication_failure','unclassified_failure','evaluation_invalid','future_unknown']){
  expect(disposition(classification)).toBe('stop');
  expect(groupDecision([done,{classification},done],false,10*3600000)).toBe('stop_execution');
 }
});
