import {join} from 'node:path';
import {readFileSync,mkdirSync,readdirSync,writeFileSync,rmdirSync,existsSync} from 'node:fs';
import {STUDY,IMAGE} from '../v1/settings.ts';
export {STUDY,IMAGE};
export const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export function authorization(){
 const a=read(join(STUDY,'authorization.json')),start=Date.parse(a.startedAt),deadline=Date.parse(a.deadline);
 if(existsSync(join(STUDY,'closure.json')))throw Error('研究已经关闭，不能重新启动');
 if(!process.env.AXI_REVIEW_STUDY||process.env.AXI_REVIEW_STUDY!==STUDY||process.env.AXI_EVAL_IMAGE!==IMAGE||process.env.AXI_V1_NODE_PROFILE!=='node22'||!IMAGE.startsWith('sha256:')||a.plan!=='docs/11-v1-delivery-review-plan.md'||a.confirmedBy!=='user'||a.maxStarts!==33||a.maxDevelopment!==4||a.maxC7!==2||a.maxFormal!==21||a.maxProbes!==6||a.maxUpstreamRecovery!==1||a.maxGradeRecovery!==1||a.reportReserveMinutes!==30||a.taskSeconds!==1800||a.gradeSeconds!==900||a.taskRequests!==50||a.workRequests!==40||a.reviewRequests!==10||a.probeSeconds!==120||a.probeRequests!==12)throw Error('有界复核授权或环境不符');
 if(!Number.isFinite(start)||!Number.isFinite(deadline)||deadline-start!==18*3600000||Date.now()<start||Date.now()>=deadline-30*60000)throw Error('授权时间无效或工作截止已到');
 return {...a,workDeadline:deadline-30*60000};
}
export type StartKind='development'|'c7'|'formal'|'probe';
export function claimStart(id:string,kind:StartKind,metadata:unknown){
 const a=authorization(),directory=join(STUDY,'starts');mkdirSync(directory,{recursive:true,mode:0o700});
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('无效启动ID');
 const lock=join(STUDY,'starts.lock');mkdirSync(lock,{mode:0o700});
 try{
  const prior=readdirSync(directory).map(p=>read(join(directory,p))),limits={development:4,c7:2,formal:21,probe:6};
  if(prior.length>=33||prior.filter(x=>x.kind===kind).length>=limits[kind])throw Error('真实启动额度已用尽');
  if(Date.now()+(kind==='probe'?120000:45*60000)>a.workDeadline)throw Error('剩余时间不能容纳执行和评分');
  writeFileSync(join(directory,id+'.json'),JSON.stringify({id,kind,time:new Date().toISOString(),metadata},null,2)+'\n',{flag:'wx',mode:0o400});
 }finally{rmdirSync(lock)}
}
