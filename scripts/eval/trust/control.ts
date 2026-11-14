export type StopState={state:'running'|'no_new_models'|'draining'|'grading_blocked'|'closed';gradingAllowed:boolean;active:boolean};
// 停新增与取消在途是两件事。安全的在途任务完成封存后，评分只受设施可信状态控制。
export function stopState(active:boolean,gradingAllowed:boolean):StopState{return {state:active?'draining':gradingAllowed?'no_new_models':'grading_blocked',gradingAllowed,active}}
export function mayStart(s:StopState){return s.state==='running'}
export function mayGrade(s:StopState){return s.gradingAllowed&&s.state!=='closed'}
export function afterDrain(s:StopState):StopState{return {...s,active:false,state:s.gradingAllowed?'no_new_models':'grading_blocked'}}
