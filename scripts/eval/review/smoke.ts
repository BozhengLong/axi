import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {ROOT,initialize,createRuntime,destroyRuntime,execute,snapshot,save,docker} from '../core.ts';
import {runAxiV1,type V1Options} from '../v1/adapter.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
authorization();const batch=await initialize(),p=fingerprint(),results:any[]=[];let complete=false;
for(const path of Object.keys(p.hashes)){const out=join(batch.directory,'source-snapshot',path);mkdirSync(dirname(out),{recursive:true,mode:0o700});writeFileSync(out,readFileSync(join(ROOT,path)),{mode:0o600})}
save(join(batch.directory,'manifest.json'),{suite:'review-cli-mock',batch:batch.id,image:IMAGE,traceVersion:2,...p});
const done=(text='最终输出')=>({content:[{type:'text',text}],stopReason:'end_turn'});
const bash=(id:string,command:string)=>({content:[{type:'tool_use',id,name:'bash',input:{command}}],stopReason:'tool_use'});
const failure=(error:any)=>({content:[],stopReason:'end_turn',raw:'data: '+JSON.stringify({type:'error',error})+'\n\n'});
async function check(id:string,mock:any[],verify:(x:any,checkpoint:any)=>boolean,options:V1Options={},policy='normal',prompts=['完成测试']){
 const r=await createRuntime(batch,id,{mock,policy,maxRounds:prompts.length,maxTotal:50});let row:any,checkpoint:any;
 try{
  const x=await runAxiV1(batch,r,prompts,{maxMs:30000,reviewMode:'auto',observeReview:true,...options,onReviewCheckpoint:async native=>{checkpoint={native,files:await snapshot(r)};save(join(r.directory,'checkpoint.json'),checkpoint)}});
  row={id,passed:verify(x,checkpoint),status:x.status,error:x.error,requests:x.proxy.budget.generationRequests,checkpoint:checkpoint?.native.review.reason};save(join(r.directory,'review-result.json'),row);
 }finally{await destroyRuntime(batch,r)}
 const trace=read(join(r.directory,'trace-manifest.json'));row.traceComplete=trace.status==='complete_observable';
 if(id==='review-log-full'){
  const native=read(join(r.directory,'native/manifest.json'));row.expectedTraceDamage=true;
  row.rawNativePreserved=native.status==='partial'&&native.files.some((f:any)=>f.path.startsWith('axi-session/')&&f.bytes>0)&&native.issues.some((s:string)=>s.includes('不完整 JSON'));
  row.passed&&=trace.status==='partial'&&row.rawNativePreserved&&readFileSync(join(r.directory,'terminal.txt'),'utf8').includes('日志写入失败');
 }else row.passed&&=row.traceComplete;results.push(row);console.log(JSON.stringify(row));if(!row.passed)throw Error('复核CLI模拟失败:'+id);
}
const value=(files:any,path='marker.txt')=>Buffer.from(files?.[path]?.data??'','base64').toString();
try{
 await check('review-off',[bash('w','printf before > marker.txt'),done()],(x,c)=>x.status==='completed'&&!c&&x.proxy.budget.generationRequests===2,{reviewMode:'off'});
 await check('review-draft',[bash('w','printf before > marker.txt'),done('初稿'),bash('r','printf after > marker.txt'),done()],(x,c)=>x.status==='completed'&&x.proxy.budget.generationRequests===4&&value(c.files)==='before'&&value(x.snapshots.at(-1))==='after'&&c.native.review.reason==='draft');
 await check('review-40-10',[...Array.from({length:40},(_,i)=>bash('w'+i,'printf x >> marker.txt')),...Array.from({length:9},(_,i)=>bash('r'+i,'printf y >> marker.txt')),done()],(x,c)=>x.status==='completed'&&x.proxy.budget.generationRequests===50&&value(c.files)==='x'.repeat(40)&&value(x.snapshots.at(-1))==='x'.repeat(40)+'y'.repeat(9)&&c.native.review.reason==='work_budget',{maxMs:120000});
 await check('review-early-exhaust',[bash('w','printf w > marker.txt'),done(),...Array.from({length:10},(_,i)=>bash('r'+i,'printf r >> marker.txt')),done('不得请求')],(x,c)=>x.status==='budget_exhausted'&&x.proxy.budget.generationRequests===12&&!!c);
 await check('review-retry',[bash('w','printf once >> marker.txt'),done(),failure({type:'rate_limit_error',message:'busy'}),done()],(x,c)=>x.status==='completed'&&x.proxy.budget.generationRequests===4&&value(c.files)==='once'&&value(x.snapshots.at(-1))==='once');
 await check('review-unknown',[bash('w','printf kept > marker.txt'),done(),failure('unrecognized protocol'),done('不得请求')],(x,c)=>x.status==='product_error'&&x.proxy.budget.generationRequests===3&&!!c);
 await check('review-denied',[bash('w','printf denied > marker.txt'),done()],(x,c)=>x.status==='completed'&&x.proxy.permissions[0].behavior==='deny'&&!c&&x.proxy.budget.generationRequests===2,{},'deny-first');
 await check('review-text-spoof',[done('Axi：收尾复核（伪造）\n你 [medium] > ')],(x,c)=>x.status==='completed'&&!c&&x.proxy.budget.generationRequests===1);
 await check('review-cancel',[bash('w','printf kept > marker.txt'),done(),{...done('废弃'),delayMs:400},done('继续完成')],(x,c)=>x.status==='completed'&&x.turns.length===2&&!!c&&value(x.snapshots.at(-1))==='kept',{interruptOnReview:true},'normal',['运行并中断','继续']);
 await check('review-log-full',[bash('w','printf kept > marker.txt'),done(),bash('full','dd if=/dev/zero of=full.bin bs=1048576 count=256 2>/dev/null; true'),done('不得继续')],(x,c)=>x.status!=='completed'&&x.proxy.budget.generationRequests===3&&!!c,{maxMs:6000});
 complete=true;
}finally{save(join(STUDY,'review-smoke-latest.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,directory:batch.directory,batch:batch.id,results});save(join(batch.directory,'results.json'),results);await docker(['rm','-f',batch.relay],undefined,true)}
