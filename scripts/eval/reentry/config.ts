import {join} from 'node:path';
import {readFileSync,existsSync,mkdirSync,readdirSync,writeFileSync,rmdirSync} from 'node:fs';
import {STUDY,IMAGE} from '../v1/settings.ts';
import {stopState,mayGrade} from './control.ts';
import {STORE,save} from '../core.ts';
export {STUDY,IMAGE};
export const HISTORY=join(STORE,'v1-review-20261114');
export const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export const tasks=['V1-E','V1-D'] as const;
export type DevTask=typeof tasks[number];
export const developmentSchedule=[{task:'V1-E',product:'current'},{task:'V1-E',product:'candidate'},{task:'V1-D',product:'candidate'},{task:'V1-D',product:'current'}] as const;
export function authorization(){
 const a=read(join(STUDY,'authorization.json'));
 const expected={maxStarts:34,maxDevelopment:4,maxC7:2,maxFormal:21,maxProbes:7,maxUpstreamRecovery:1,maxGradeRecovery:1,reportReserveMinutes:30,taskSeconds:1800,gradeSeconds:900,taskRequests:50,workRequests:40,reviewRequests:10,probeSeconds:120,probeRequests:12,groupSeconds:9000,recoveryGroupSeconds:9360};
 if(process.env.AXI_REENTRY_STUDY!==STUDY||process.env.AXI_EVAL_IMAGE!==IMAGE||process.env.AXI_V1_NODE_PROFILE!=='node22'||read(join(STUDY,'image.json')).image!==IMAGE||a.plan!=='docs/13-v1-reentrancy-qualification-plan.md'||a.confirmedBy!=='user'||Object.entries(expected).some(([k,v])=>a[k]!==v))throw Error('重入资格授权或环境不符');
 const start=Date.parse(a.startedAt),deadline=Date.parse(a.deadline);
 if(!Number.isFinite(start)||deadline-start!==18*3600000||Date.now()<start||Date.now()>=deadline-30*60000)throw Error('研究工作窗口无效或已结束');
 if(existsSync(join(STUDY,'closure.json')))throw Error('研究已关闭');
 return {...a,workDeadline:deadline-30*60000};
}
export type StartKind='development'|'c7'|'formal'|'probe';
export function claimStart(id:string,kind:StartKind,metadata:unknown){
 const a=authorization();if(existsSync(join(STUDY,'stop.json')))throw Error('已停止新增模型');
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('启动ID无效');
 const directory=join(STUDY,'starts');mkdirSync(directory,{recursive:true,mode:0o700});
 const lock=join(STUDY,'starts.lock');mkdirSync(lock,{mode:0o700});
 try{
  const prior=readdirSync(directory).map(p=>read(join(directory,p))),limits={development:4,c7:2,formal:21,probe:7};
  if(prior.length>=34||prior.filter(x=>x.kind===kind).length>=limits[kind])throw Error('真实启动额度已用尽');
  if(Date.now()+(kind==='probe'?120000:45*60000)>a.workDeadline)throw Error('不能容纳完整执行与评分窗口');
  writeFileSync(join(directory,id+'.json'),JSON.stringify({id,kind,time:new Date().toISOString(),metadata},null,2)+'\n',{flag:'wx',mode:0o400});
 }finally{rmdirSync(lock)}
}
export function requestStop(reason:string,gradingAllowed:boolean){
 const path=join(STUDY,'stop.json'),owner=join(STUDY,'resource.lock','owner.json');const active=existsSync(owner)&&/^(live:|preflight:live)/.test(read(owner).kind);
 if(!existsSync(path))save(path,{...stopState(active,gradingAllowed),reason,time:new Date().toISOString()});
}
export function assertGradingAllowed(){
 authorization();const path=join(STUDY,'stop.json');if(existsSync(path)&&!mayGrade(read(path)))throw Error('评分已被阻断，产物只能封存');
}
