import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {STUDY,IMAGE} from '../v1/settings.ts';
export {STUDY,IMAGE};
export const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
export function authorization(){
 const a=read(join(STUDY,'authorization.json'));
 if(!process.env.AXI_V1_STUDY||process.env.AXI_V1_NODE_PROFILE!=='node22'||process.env.AXI_EVAL_IMAGE!==IMAGE||a.plan!=='v1-stable-D1-D5'||a.confirmedBy!=='user'||a.nodeVersion!=='22.23.5'||a.plannedStarts!==18||a.maxStarts!==21||a.maxGradeRecovery!==1||a.maxUpstreamRecovery!==1||a.maxProbeStarts!==6)throw Error('不是已确认的稳定化profile');
 if(a.image&&a.image!==IMAGE)throw Error('镜像与冻结授权不一致');
 const deadline=Date.parse(a.deadline),start=Date.parse(a.start);
 if(!Number.isFinite(deadline)||deadline-start>18*3600000||deadline<=Date.now())throw Error('绝对截止不合法或已到期');
 return {...a,deadlineMs:deadline,workDeadline:deadline-30*60000};
}
