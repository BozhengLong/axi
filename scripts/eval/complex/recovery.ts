export type Trial = {task:string;repeat:number;agent:string;id:string};
// 只补一次完整配对。保留前面所有有效结果，包括正常的任务失败。
export function recoveryPlan(schedule:Trial[],results:{id:string}[],incident:{classification:string;run:string}) {
 if(incident.classification!=="environment_indeterminate")throw Error("产品失败不能触发环境补跑");
 const failed=schedule.findIndex(r=>r.id===incident.run);
 if(failed<0||results.length!==failed+1||results.some((r,i)=>r.id!==schedule[i]?.id))throw Error("原结果不是截至事故的完整计划前缀");
 const start=failed-failed%2;
 if(!schedule[start+1]||schedule[start]!.task!==schedule[start+1]!.task||schedule[start]!.repeat!==schedule[start+1]!.repeat||schedule[start]!.agent===schedule[start+1]!.agent)throw Error("原计划不是完整配对");
 return {
   retainedIds:schedule.slice(0,start).map(r=>r.id),
   excludedIds:results.slice(start).map(r=>r.id),
   schedule:schedule.slice(start).map((r,i)=>({...r,id:i<2?r.id+"-retry1":r.id,originalRunId:r.id,originalOrdinal:start+i+1,recoveryAttempt:i<2?1:0})),
 };
}
