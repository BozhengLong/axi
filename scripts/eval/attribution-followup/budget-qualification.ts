import {join} from 'node:path';
import {mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {command,save,ROOT} from '../core.ts';
import {STUDY,IMAGE,authorization} from './config.ts';
const a=authorization(),directory=join(STUDY,'budget-qualification-'+Date.now()),before=readdirSync(join(STUDY,'starts')).length;
const cases=['wrong-clock','expired','preparation-expired','closed','wrong-probe','duplicate-probe','task-before-probes','duplicate-task','out-of-order-task','closed-module','independent-module','maximum-starts','insufficient-task-time','valid-sequence'];
const rows=[];
for(const name of cases){
 const dest=join(directory,name);mkdirSync(join(dest,'starts'),{recursive:true,mode:0o700});
 const now=Date.now(),start=name==='expired'?now-25*3600000:name==='preparation-expired'?now-7*3600000:name==='insufficient-task-time'?now-(23*60-44)*60000:now;
 const auth={...a,startedAt:new Date(start).toISOString(),deadline:new Date(start+(name==='wrong-clock'?23:24)*3600000).toISOString(),preparationDeadline:new Date(start+6*3600000).toISOString()};
 save(join(dest,'authorization.json'),auth);save(join(dest,'image.json'),{image:IMAGE,liveAllowed:false,qualificationOnly:true});
 if(name==='closed')save(join(dest,'closure.json'),{qualificationOnly:true});
 const source=`import {writeFileSync} from 'node:fs';import{join}from'node:path';import{authorization,assertPreparation,claimStart,STUDY,developmentSchedule,pairs}from${JSON.stringify(join(ROOT,'scripts/eval/attribution-followup/config.ts'))};import{freshState}from${JSON.stringify(join(ROOT,'scripts/eval/attribution-followup/modules.ts'))};
const name=${JSON.stringify(name)},save=(n,x)=>writeFileSync(join(STUDY,n),JSON.stringify(x));let rejected=false;
try{
 if(['wrong-clock','expired','closed'].includes(name)){authorization()}
 else if(name==='preparation-expired'){assertPreparation()}
 else if(name==='wrong-probe'){claimStart('initial-probe-claude','probe',{})}
 else if(name==='duplicate-probe'){claimStart('initial-probe-axi','probe',{});claimStart('initial-probe-axi','probe',{})}
 else if(name==='task-before-probes'){claimStart('Q1-axi','task',{})}
 else{
  claimStart('initial-probe-axi','probe',{});claimStart('initial-probe-claude','probe',{});const state=freshState(developmentSchedule,pairs);
  if(['closed-module','independent-module'].includes(name)){for(const m of ['Q','E']){state.modules[m].status='closed';for(const s of state.slots.filter(x=>x.module===m))s.status='closed_dependency'}}
  save('attribution.json',state);
  if(name==='maximum-starts'){for(let i=0;i<16;i++)save('starts/fake-'+i+'.json',{id:'fake-'+i,qualificationOnly:true})}
  const id=name==='out-of-order-task'?'Q2-claude':name==='independent-module'?'D1-axi':'Q1-axi';claimStart(id,'task',{});
  if(name==='duplicate-task')claimStart(id,'task',{});
 }
}catch(error){rejected=true}
console.log(JSON.stringify({rejected,modelCalls:0}));`;
 writeFileSync(join(dest,'check.ts'),source,{mode:0o600});
 const child=Bun.spawn(['bun',join(dest,'check.ts')],{cwd:ROOT,env:{...process.env,AXI_V1_STUDY:dest,AXI_ATTRIBUTION_FOLLOWUP_STUDY:dest},stdout:'pipe',stderr:'pipe'});
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 const result=code===0?JSON.parse(stdout):null,expectReject=!['valid-sequence','independent-module'].includes(name),passed=code===0&&result.rejected===expectReject;
 rows.push({name,passed,expectReject,result,code,stderr});save(join(directory,'rows.json'),rows);if(!passed)throw Error('启动额度资格失败:'+name);
}
if(readdirSync(join(STUDY,'starts')).length!==before)throw Error('资格检查改写真实启动台账');
save(join(STUDY,'budget-qualification-latest.json'),{complete:true,directory,rows,realStartCountUnchanged:true,modelCalls:0});console.log(JSON.stringify({complete:true,checks:rows.length,modelCalls:0}));
