import {join} from 'node:path';
import {readFileSync,existsSync,mkdirSync,readdirSync,writeFileSync,rmdirSync} from 'node:fs';
import {STUDY,IMAGE} from '../v1/settings.ts';
import {stopState,mayGrade} from './control.ts';
import {STORE,save} from '../core.ts';
export {STUDY,IMAGE};
export const HISTORY=join(STORE,'v1-reentry-20261115');
export const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export const tasks=['V1-E','V1-D'] as const;
export const allTasks=['V1-E','V1-D','V1-U','V1-Q'] as const;
export type DevTask=typeof allTasks[number];
export const pairs=[
 {id:'P1',task:'V1-E',repeat:1,products:['axi','claude']},
 {id:'P2',task:'V1-D',repeat:1,products:['claude','axi']},
 {id:'P3',task:'V1-E',repeat:2,products:['claude','axi']},
 {id:'P4',task:'V1-D',repeat:2,products:['axi','claude']},
 {id:'Q1',task:'V1-U',repeat:1,products:['axi','claude']},
 {id:'Q2',task:'V1-Q',repeat:1,products:['claude','axi']},
 {id:'Q3',task:'V1-Q',repeat:2,products:['axi','claude']},
 {id:'Q4',task:'V1-U',repeat:2,products:['claude','axi']},
] as const;
export const developmentSchedule=pairs.flatMap(pair=>pair.products.map(product=>({...pair,product,id:pair.id+'-'+product})));
export function authorization(){
 const a=read(join(STUDY,'authorization.json'));
 const expected={maxStarts:18,maxTasks:16,maxProbes:2,maxUpstreamRecovery:0,maxGradeRecovery:1,reportReserveMinutes:30,taskSeconds:1800,gradeSeconds:900,taskRequests:50,workRequests:40,reviewRequests:10,probeSeconds:120,probeRequests:12,pairSeconds:6000};
 if(process.env.AXI_ATTRIBUTION_STUDY!==STUDY||process.env.AXI_EVAL_IMAGE!==IMAGE||process.env.AXI_V1_NODE_PROFILE!=='node22'||read(join(STUDY,'image.json')).image!==IMAGE||a.plan!=='docs/16-v1-axi-claude-attribution-plan.md'||a.confirmedBy!=='user'||Object.entries(expected).some(([k,v])=>a[k]!==v))throw Error('归因授权或环境不符');
 const start=Date.parse(a.startedAt),deadline=Date.parse(a.deadline),preparationDeadline=Date.parse(a.preparationDeadline);
 if(!Number.isFinite(start)||deadline-start!==18*3600000||preparationDeadline-start!==4*3600000||Date.now()<start||Date.now()>=deadline-30*60000)throw Error('研究工作窗口无效或已结束');
 if(existsSync(join(STUDY,'closure.json')))throw Error('研究已关闭');
 return {...a,preparationDeadline,workDeadline:deadline-30*60000};
}
export function assertPreparation(){const a=authorization();if(Date.now()>=a.preparationDeadline)throw Error('准备窗口已结束');return a}
export type StartKind='task'|'probe';
export function claimStart(id:string,kind:StartKind,metadata:unknown){
 const a=authorization();if(existsSync(join(STUDY,'stop.json')))throw Error('已停止新增模型');
 const directory=join(STUDY,'starts');mkdirSync(directory,{recursive:true,mode:0o700});
 const lock=join(STUDY,'starts.lock');mkdirSync(lock,{mode:0o700});
 try{
  const prior=readdirSync(directory).map(p=>read(join(directory,p))),ordered=['initial-probe-axi','initial-probe-claude',...developmentSchedule.map(x=>x.id)];
  if(prior.length>=18||id!==ordered[prior.length]||kind!==(prior.length<2?'probe':'task'))throw Error('启动顺序、类型或额度不符');
  if(Date.now()+(kind==='probe'?120000:45*60000)>a.workDeadline)throw Error('不能容纳完整执行与评分窗口');
  writeFileSync(join(directory,id+'.json'),JSON.stringify({id,kind,time:new Date().toISOString(),metadata},null,2)+'\n',{flag:'wx',mode:0o400});
 }finally{rmdirSync(lock)}
}
export function requestStop(reason:string,gradingAllowed:boolean){
 const path=join(STUDY,'stop.json'),owner=join(STUDY,'resource.lock','owner.json');const active=existsSync(owner)&&/^(live:|preflight:live)/.test(read(owner).kind);
 if(!existsSync(path))save(path,{...stopState(active,gradingAllowed),reason,time:new Date().toISOString()});
}
export function assertGradingAllowed(){authorization();const path=join(STUDY,'stop.json');if(existsSync(path)&&!mayGrade(read(path)))throw Error('评分已被阻断，产物只能封存')}
