import {join,resolve,relative} from 'node:path';
import {readFileSync} from 'node:fs';
import {save,ROOT} from '../core.ts';
import {digestBytes} from '../stable/profile.ts';
import {authorization,STUDY,read} from './config.ts';
import {profile} from './profile.ts';
import {openIssue,verifyIsolation,closeIssue,type ModuleId,type IssueScope} from './modules.ts';
import {runSentinels} from './sentinel.ts';
import {scopesFor} from './dependency-scope.ts';
authorization();const path=join(STUDY,'attribution.json'),state=read(path),p=profile(),action=process.argv[2],input=read(process.argv[3]??'');
if(typeof input.id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(input.id))throw Error('故障编号无效');
const mapPath=join(ROOT,'evals/specs/v1-attribution-followup-v1/dependency-map.json'),map=read(mapPath),mapHash=digestBytes(readFileSync(mapPath));
function evidence(path:string){const absolute=resolve(STUDY,path);if(relative(STUDY,absolute).startsWith('..'))throw Error('故障证据必须在本研究目录');return {path,hash:digestBytes(readFileSync(absolute))}}
function scope(files:string[]):IssueScope{
 if(!Array.isArray(files)||!files.length)throw Error('缺少故障依赖文件');
 const repair=p.graderEpoch===1?read(join(STUDY,'grade-repair-decision.json')):undefined;
 for(const file of files){const actual=digestBytes(readFileSync(join(ROOT,file))),entry=map.files[file],change=repair?.measurementChanges?.[file];if(!entry||JSON.stringify(entry.modules)!==JSON.stringify(scopesFor(file))||actual!==entry.sha256&&!(change?.prior===entry.sha256&&change.next===actual))throw Error('故障文件未按冻结依赖定位');}
 const modules=new Set(files.flatMap(scopesFor));return modules.size===3?'common':modules.has('E')?'E':modules.has('D')?'D':'Q';
}
if(action==='--declare'){
 if(!['contract','measurement','safety'].includes(input.kind))throw Error('故障类型无效');
 const reproduction=evidence(input.reproduction),actual=scope(input.files);
 const issue=openIssue(state,{id:input.id,scope:actual,kind:input.kind,reason:input.reason,openedAt:Date.now()});
 save(join(STUDY,'incidents',input.id+'-declaration.json'),{...input,scope:actual,reproduction,dependencyMapHash:mapHash});state.phase='incident_required';save(path,state);
 console.log(JSON.stringify({id:issue.id,scope:issue.scope,global:state.global}));
}else if(action==='--isolate'||action==='--isolate-close'){
 const issue=state.issues.find((x:any)=>x.id===input.id);if(!issue||issue.state!=='paused'||issue.kind==='safety')throw Error('故障不允许定位关闭');
 const reproduction=evidence(input.reproduction),actual=scope(input.files);
 if(actual==='common')throw Error('共同依赖不能局部继续');
 if(issue.scope==='common'){
  // 自动检测只能给出未知的共同范围；实际故障文件和哨兵才能收窄。
  if(!issue.uncertainScope)throw Error('已确认共同故障不能收窄');
  issue.scope=actual;issue.affected=actual==='E'?['Q','E']:[actual];
  for(const m of ['Q','D','E']as const)if(!issue.affected.includes(m)&&state.modules[m].status==='paused')state.modules[m]={status:'active'};
 }else if(issue.scope!=='sample'&&issue.scope!==actual)throw Error('不能更换已声明局部范围');
 if(issue.scope==='sample'&&(!state.rows.some((r:any)=>r.execution.id===issue.sample&&r.execution.artifactHash===input.artifactHash)))throw Error('缺少故障样本封存身份');
 const modules=(['Q','D','E']as ModuleId[]).filter(m=>issue.kind==='sample'?state.modules[m].status!=='closed':!issue.affected.includes(m)&&state.modules[m].status==='active');
 const sentinel=await runSentinels(modules,join(STUDY,'incidents',input.id+'-sentinels'));
 const proof={incident:issue.id,dependencyMapHash:mapHash,reproduction:reproduction.path,reproductionHash:reproduction.hash,sentinels:sentinel.rows,recordedAt:Date.now()};
 verifyIsolation(state,issue.id,proof,mapHash,p.moduleGraderRevisions,Date.now());
 if(action==='--isolate-close')closeIssue(state,issue.id);
 save(join(STUDY,'incidents',issue.id+'-'+(action==='--isolate'?'isolation':'close')+'.json'),{proof,files:input.files,reason:input.reason});state.phase=state.global==='running'?'running':'incident_required';save(path,state);
 console.log(JSON.stringify({global:state.global,modules:state.modules,attributionStatus:'A-INCOMPLETE'}));
}else if(action==='--close-known'){
 const issue=state.issues.find((x:any)=>x.id===input.id),proof=issue?.proof;if(!issue||issue.state!=='paused'||issue.kind==='safety'||issue.scope==='common'||!proof)throw Error('缺少既有局部证明');
 if(proof.dependencyMapHash!==mapHash||proof.recordedAt-issue.openedAt>30*60000||evidence(proof.reproduction).hash!==proof.reproductionHash)throw Error('原定位证据无效');
 const modules=(['Q','D','E']as const).filter(m=>issue.kind==='sample'?state.modules[m].status!=='closed':!issue.affected.includes(m)&&state.modules[m].status==='active');
 for(const module of modules){const sentinel=proof.sentinels.find((r:any)=>r.module===module);if(!sentinel?.positive||!sentinel.negative||sentinel.dependencyHash!==p.moduleGraderRevisions[module]||evidence(sentinel.report).hash!==sentinel.reportHash)throw Error('未受影响模块证据改变，不能继续');}
 closeIssue(state,issue.id);state.phase=state.global==='running'?'running':'incident_required';save(join(STUDY,'incidents',issue.id+'-closed-after-repair.json'),{proof,reason:input.reason,time:Date.now()});save(path,state);console.log(JSON.stringify({global:state.global,modules:state.modules}));
}else throw Error('需要--declare、--isolate、--isolate-close或--close-known及证据JSON');
