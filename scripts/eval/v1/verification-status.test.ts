import {expect,test} from 'bun:test';
import {assertVerificationCompleted} from './verification-status.ts';
test('执行器中断独立验收时保留不可判定，不冒充候选代码失败',()=>{
 expect(()=>assertVerificationCompleted({exitCode:137,timedOut:true},'types')).toThrow('verification_indeterminate:types');
 expect(()=>assertVerificationCompleted({exitCode:137,timedOut:false},'types')).toThrow('verification_indeterminate');
 expect(()=>assertVerificationCompleted({exitCode:143},'original-tests')).toThrow('verification_indeterminate');
 for(const exitCode of [0,1,2])expect(()=>assertVerificationCompleted({exitCode,timedOut:false},'contract')).not.toThrow();
});
