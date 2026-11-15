export type ModuleId='Q'|'D'|'E';
export type SlotStatus='unstarted'|'running'|'sealed'|'grading'|'manual_review_required'|'judged'|'indeterminate'|'closed_dependency';
export type IssueScope='common'|'E'|'D'|'Q'|'sample';
export type IssueKind='contract'|'measurement'|'sample'|'safety';
export type Slot={id:string;pair:string;module:ModuleId;status:SlotStatus;reason?:string;artifactHash?:string};
export type Incident={id:string;scope:IssueScope;kind:IssueKind;sample?:string;reason:string;openedAt:number;affected:ModuleId[];state:'paused'|'repairing'|'closed'|'repaired';proof?:IsolationProof;uncertainScope?:boolean};
export type IsolationProof={incident:string;dependencyMapHash:string;reproduction:string;reproductionHash:string;sentinels:{module:ModuleId;positive:boolean;negative:boolean;reportHash:string;dependencyHash:string}[];recordedAt:number};
export type ModuleState={slots:Slot[];modules:Record<ModuleId,{status:'active'|'paused'|'closed';reason?:string}>;issues:Incident[];global:'running'|'paused'|'closed';repair:{used:boolean;startedAt?:number;deadline?:number;issue?:string}};
export function freshState(schedule:readonly {id:string;module:string}[],pairs:readonly {id:string;module:string;products:readonly string[]}[]):ModuleState{
 const slots=schedule.map(x=>{const pair=pairs.find(p=>p.products.some(product=>p.id+'-'+product===x.id));if(!pair)throw Error('槽位没有配对');return {id:x.id,pair:pair.id,module:x.module as ModuleId,status:'unstarted' as const}});
 return {slots,modules:{Q:{status:'active'},D:{status:'active'},E:{status:'active'}},issues:[],global:'running',repair:{used:false}};
}
export const affectedModules=(scope:IssueScope,sample?:Slot):ModuleId[]=>scope==='common'?['Q','D','E']:scope==='E'?['Q','E']:scope==='sample'?(sample?[sample.module]:[]):[scope];
export function nextSlot(state:ModuleState){if(state.global!=='running')return;return state.slots.find(s=>s.status==='unstarted'&&state.modules[s.module].status==='active')}
export function resolvedSample(state:ModuleState,id:string){return state.slots.some(s=>s.id===id&&s.status==='indeterminate')&&state.issues.some(i=>i.kind==='sample'&&i.sample===id&&i.state==='closed'&&!!i.proof)}
export function assertClaim(state:ModuleState,id:string){const slot=nextSlot(state);if(!slot||slot.id!==id)throw Error('槽位顺序或模块状态禁止启动');return slot}
export function setSlot(state:ModuleState,id:string,next:SlotStatus,artifactHash?:string){
 const slot=state.slots.find(x=>x.id===id);if(!slot)throw Error('槽位不存在');
 const allowed:Record<SlotStatus,SlotStatus[]>={unstarted:['running','closed_dependency'],running:['sealed','indeterminate'],sealed:['grading','indeterminate'],grading:['manual_review_required','indeterminate'],manual_review_required:['judged','indeterminate'],judged:['indeterminate'],indeterminate:['grading','manual_review_required'],closed_dependency:[]};
 if(!allowed[slot.status].includes(next))throw Error('非法槽位迁移:'+slot.status+'->'+next);
 if(artifactHash){if(slot.artifactHash&&slot.artifactHash!==artifactHash)throw Error('恢复不能换产物');slot.artifactHash=artifactHash}
 slot.status=next;
}
export function openIssue(state:ModuleState,input:Omit<Incident,'affected'|'state'>){
 if(state.issues.some(x=>x.id===input.id))throw Error('重复故障编号');
 if(state.global!=='running'&&input.kind!=='safety')throw Error('先处理当前暂停，不能并发改变故障范围');
 const sample=state.slots.find(x=>x.id===input.sample),affected=affectedModules(input.scope,sample);
 if(input.scope==='sample'&&(!sample||input.kind!=='sample'))throw Error('样本范围缺少真实槽位');
 const issue:Incident={...input,affected,state:'paused'};state.issues.push(issue);
 // 先暂停全部，取得依赖与正反哨兵证据后才能继续独立部分。
 state.global='paused';for(const module of affected)state.modules[module]={status:'paused',reason:input.reason};
 if(input.kind==='safety'||input.scope==='common'&&input.kind==='contract')closeIssue(state,issue.id);
 return issue;
}
export function verifyIsolation(state:ModuleState,id:string,proof:IsolationProof,mapHash:string,moduleHashes:Record<ModuleId,string>,now:number){
 const issue=state.issues.find(x=>x.id===id);if(!issue||issue.state!=='paused')throw Error('故障状态不能定位');
 if(issue.scope==='common'||issue.kind==='safety')throw Error('共同故障不能隔离为局部');
 if(proof.incident!==id||proof.dependencyMapHash!==mapHash||!proof.reproduction||!/^[a-f0-9]{64}$/.test(proof.reproductionHash)||proof.recordedAt<issue.openedAt||proof.recordedAt>now||now-issue.openedAt>30*60000)throw Error('缺少有界定位证据');
 const unaffected=(['Q','D','E']as const).filter(m=>issue.kind==='sample'?state.modules[m].status!=='closed':!issue.affected.includes(m)&&state.modules[m].status==='active');
 for(const module of unaffected){const row=proof.sentinels.find(x=>x.module===module);if(!row?.positive||!row.negative||!/^[a-f0-9]{64}$/.test(row.reportHash)||row.dependencyHash!==moduleHashes[module])throw Error('缺少不受影响模块的正反哨兵')}
 issue.proof=proof;
}
export function closeIssue(state:ModuleState,id:string){
 const issue=state.issues.find(x=>x.id===id);if(!issue)throw Error('无此故障');issue.state='closed';
 if(issue.kind==='sample'){
  const slot=state.slots.find(x=>x.id===issue.sample)!;slot.status='indeterminate';slot.reason=issue.reason;
  if(!issue.proof){state.global='paused';return;}
  for(const m of issue.affected)if(!state.issues.some(x=>x.id!==id&&x.state==='closed'&&x.kind!=='sample'&&x.affected.includes(m)))state.modules[m]={status:'active'};
 }else{
  for(const module of issue.affected){state.modules[module]={status:'closed',reason:issue.reason};for(const slot of state.slots.filter(x=>x.module===module)){if(slot.status==='unstarted')slot.status='closed_dependency';else if(slot.status!=='closed_dependency')slot.status='indeterminate';slot.reason=issue.reason}}
 }
 state.global=issue.scope==='common'||issue.kind==='safety'?'closed':issue.proof?'running':'paused';
 const rows=(state as ModuleState&{rows?:any[]}).rows??[];
 for(const row of rows.filter(r=>issue.kind==='sample'?r.execution.id===issue.sample:issue.affected.includes(r.module))){
  row.adjudicationHistory=[...(row.adjudicationHistory??[]),{incident:issue.id,fullDeliveryPassed:row.fullDeliveryPassed,targetRepairPassed:row.targetRepairPassed,manualReview:row.manualReview,time:Date.now()}];
  // 原机判和失败证据保留；撤回当前结论，人工复核再区分可信失败与未知。
  row.fullDeliveryPassed=null;row.targetRepairPassed=null;row.adjudication='needs_reassessment';row.unresolvedIncident=issue.id;
 }
}
export function beginRepair(state:ModuleState,id:string,now:number,workDeadline:number){
 const issue=state.issues.find(x=>x.id===id);if(!issue||issue.kind!=='measurement'||issue.state!=='paused'||state.repair.used||now+120*60000>workDeadline)throw Error('不满足唯一有界测量修复条件');
 state.repair={used:true,startedAt:now,deadline:now+120*60000,issue:id};issue.state='repairing';state.global='paused';
}
export function completeRepair(state:ModuleState,id:string,now:number,evidence:{sameContract:boolean;sameExecution:boolean;qualified:boolean;allAffectedViewsRegraded:boolean}){
 if(state.global==='closed')throw Error('全局已关闭，不能以修复恢复');
 const issue=state.issues.find(x=>x.id===id);if(!issue||issue.state!=='repairing'||state.repair.issue!==id||now>state.repair.deadline!||!Object.values(evidence).every(Boolean))throw Error('修复资格、统一重评或时钟不符');
 issue.state='repaired';for(const module of issue.affected)if(!state.issues.some(x=>x.id!==id&&x.state==='closed'&&x.kind!=='sample'&&x.affected.includes(module)))state.modules[module]={status:'active'};state.global='running';
}
export function attributionStatus(state:ModuleState,healthPassed:boolean,allReviewsTrusted:boolean){return healthPassed&&allReviewsTrusted&&state.global==='running'&&state.slots.length===16&&state.slots.every(x=>x.status==='judged')&&Object.values(state.modules).every(x=>x.status==='active')&&state.issues.every(x=>x.state==='repaired')?'A-GO':'A-INCOMPLETE'}
