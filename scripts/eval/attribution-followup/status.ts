export type CommandResult={exitCode:number;stdout:string;stderr:string;timedOut?:boolean;durationMs?:number};
export class GradingIndeterminate extends Error {
 constructor(readonly origin:string,readonly stage:string,readonly evidence?:unknown){super(`评分不可判定:${origin}:${stage}`)}
}
export function classifyCommand(result:CommandResult,stage:string){
 if(result.timedOut)throw new GradingIndeterminate('supervisor_deadline',stage,result);
 if(result.exitCode>=128)throw new GradingIndeterminate('signal_or_process_exit',stage,result);
 if(/^\s*failureType:\s*['"]testTimeoutFailure['"]\s*$/m.test(result.stdout))throw new GradingIndeterminate('test_runner_timeout',stage,result);
 if(/^#? ?TRUST_ORACLE_INFRA:[A-Z0-9_]+$/m.test(result.stdout+'\n'+result.stderr))throw new GradingIndeterminate('oracle_supervisor',stage,result);
 return {origin:result.exitCode===0?'command_completed':'command_failed',stage,exitCode:result.exitCode};
}
export function testReport(result:CommandResult,stage:string,assertions:'tap'|'native-events'='tap'){
 classifyCommand(result,stage);
 const count=(key:string)=>{const hits=[...result.stdout.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];return hits.length===1?Number(hits[0]![1]):-1};
 const report={...result,total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled'),todo:count('todo'),assertionFailure:/ERR_ASSERTION|AssertionError/.test(result.stdout+result.stderr)};
 if(report.total===0||[report.total,report.passed,report.failed,report.skipped,report.cancelled,report.todo].some(n=>n<0)||report.total!==report.passed+report.failed+report.skipped+report.cancelled+report.todo)throw new GradingIndeterminate('missing_or_inconsistent_report',stage,report);
 if(report.cancelled>0)throw new GradingIndeterminate('test_cancellation',stage,report);
 if(result.exitCode===0&&report.failed>0||result.exitCode!==0&&report.failed===0)throw new GradingIndeterminate('exit_report_mismatch',stage,report);
 if(assertions==='native-events'){
  const markers=[...result.stdout.matchAll(/^# AXI_TEST_ASSERTIONS_V1 (.+)$/gm)];let evidence:any;
  try{if(markers.length!==1)throw Error('count');evidence=JSON.parse(markers[0]![1]!)}catch{throw new GradingIndeterminate('missing_assertion_evidence',stage,report)}
  if(evidence.version!==1||!Array.isArray(evidence.failures)||evidence.failures.some((f:any)=>typeof f.name!=='string'||typeof f.assertion!=='boolean'||!['structured-cause','serialized-cause','other'].includes(f.origin))||report.failed===0&&evidence.failures.length>0||report.failed>0&&evidence.failures.length===0)throw new GradingIndeterminate('invalid_assertion_evidence',stage,evidence);
  report.assertionFailure=evidence.failures.some((f:any)=>f.assertion&&f.failureType==='testCodeFailure'&&f.origin!=='other');
  return {...report,assertionEvidence:evidence};
 }
 return report;
}
export const passedTests=(r:ReturnType<typeof testReport>,count?:number)=>r.exitCode===0&&r.total>0&&r.passed===r.total&&r.skipped===0&&r.todo===0&&(count===undefined||r.total===count);
