import {test,expect} from 'bun:test';
import {classifyCommand,testReport,passedTests,GradingIndeterminate} from './status.ts';
const tap=(pass:number,fail:number,cancel=0)=>`TAP version 13\n# tests ${pass+fail+cancel}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancel}\n# skipped 0\n# todo 0\n`;
const result=(stdout:string,exitCode=0)=>({stdout,stderr:'',exitCode,timedOut:false});
test('完整行为失败与完整成功分别保留，不把行为失败变成设施错误',()=>{
 expect(passedTests(testReport(result(tap(2,0)),'current'))).toBe(true);
 const failed=testReport(result("  code: 'ERR_ASSERTION'\n"+tap(5,18),1),'old');expect(failed.total).toBe(23);expect(failed.assertionFailure).toBe(true);expect(passedTests(failed)).toBe(false);
});
test('内层文件超时即使被管道掩盖为exit0也不可判定',()=>{
 for(const exit of [0,1])expect(()=>classifyCommand(result("  failureType: 'testTimeoutFailure'\n"+tap(5,13,1),exit),'old')).toThrow('test_runner_timeout');
});
test('监督器、信号、取消和缺报告不能伪装候选失败',()=>{
 expect(()=>classifyCommand({...result(''),timedOut:true},'x')).toThrow('supervisor_deadline');
 expect(()=>classifyCommand(result('',143),'x')).toThrow('signal_or_process_exit');
 expect(()=>testReport(result(tap(0,0,1),1),'x')).toThrow('test_cancellation');
 expect(()=>testReport(result(''),'x')).toThrow('missing_or_inconsistent_report');
 expect(()=>testReport(result(tap(0,0)),'x')).toThrow('missing_or_inconsistent_report');
 expect(()=>testReport(result(tap(1,0).replace('# tests 1','# tests 2')),'x')).toThrow('missing_or_inconsistent_report');
 expect(()=>testReport(result(tap(1,0),1),'x')).toThrow('exit_report_mismatch');
});
test('语法失败不冒充有效行为回归，设施标记只匹配独立行',()=>{
 const syntax=testReport(result("  error: 'SyntaxError'\n"+tap(0,1),1),'syntax');expect(syntax.assertionFailure).toBe(false);
 expect(()=>classifyCommand(result('# TRUST_ORACLE_INFRA:ETIMEDOUT\n',1),'x')).toThrow(GradingIndeterminate);
 expect(()=>classifyCommand(result("  source: \"process.stderr.write('TRUST_ORACLE_INFRA:ETIMEDOUT')\"\n",1),'x')).not.toThrow();
});
