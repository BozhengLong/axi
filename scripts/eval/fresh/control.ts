export type Disposition='score'|'upstream'|'stop';
export function disposition(classification:string):Disposition{
 if(['completed','candidate_unfinished'].includes(classification))return 'score';
 return classification==='environment_indeterminate'?'upstream':'stop';
}
export function groupDecision(rows:{classification:string}[],recoveryUsed:boolean,remainingMs:number){
 if(rows.length!==3)return 'stop_incomplete' as const;
 if(rows.some(r=>disposition(r.classification)==='stop'))return 'stop_execution' as const;
 if(!rows.some(r=>disposition(r.classification)==='upstream'))return 'adopt' as const;
 if(recoveryUsed)return 'stop_recovery_used' as const;
 // 3个两分钟探针、完整三方窗口，再留5分钟准备和封存余量。
 if(remainingMs<146*60000)return 'stop_time' as const;
 return 'retry_whole_group' as const;
}
