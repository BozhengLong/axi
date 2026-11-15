import {join} from 'node:path';
import {existsSync,readFileSync,copyFileSync} from 'node:fs';
import {save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {digestBytes} from '../stable/profile.ts';
import {STUDY,read,pairs,authorization} from './config.ts';
import {setSlot,resolvedSample} from './modules.ts';
authorization();const id=process.argv[2],pair=pairs.find(p=>p.id===id);if(!pair)throw Error('需指定固定配对ID');
const state=read(join(STUDY,'attribution.json')),rows=state.rows.filter((r:any)=>r.pair===id);if(rows.length!==2||state.global!=='running'||state.modules[pair.module].status!=='active')throw Error('配对不完整或模块暂停/关闭');
const reviews=[];
for(const row of rows){
 const seal=verifyExecution(row.execution.runDirectory,state.executionProfileHash),revision=row.score?.graderRevision??state.moduleGraderRevisions[pair.module],preferred=join('manual-review',seal.id,revision,'review.json'),path=existsSync(join(STUDY,preferred))?preferred:join('manual-review',seal.id,'review.json'),review=read(join(STUDY,path));
 if(!review.complete||review.hardBlocker!==false||review.artifactHash!==seal.artifactHash||review.graderRevision!==revision)throw Error('人工结论缺失或未绑定产物和版本');
 if(resolvedSample(state,seal.id)){
  if(review.adjudication!=='indeterminate'||review.fullDeliveryPassed!==null)throw Error('已定位环境缺失不能改为能力通过或失败');
  row.manualReview=path;row.fullDeliveryPassed=null;row.adjudication='indeterminate';reviews.push({id:seal.id,path,sha256:digestBytes(readFileSync(join(STUDY,path))),fullDeliveryPassed:null,targetRepairPassed:null});continue;
 }
 if(row.score?.gradeStatus!=='complete'||typeof review.fullDeliveryPassed!=='boolean')throw Error('尚无可信交付判定');
 if(pair.module==='Q'&&typeof review.targetRepairPassed!=='boolean')throw Error('Q缺少独立目标修复判定');
 if(review.fullDeliveryPassed&&(['codeSemanticPass','regressionSemanticPass','documentationPass','reportPass'].some(k=>review[k]!==true)||review.deliveryVerificationComplete===false||pair.module==='Q'&&review.targetRepairPassed!==true))throw Error('完整通过与必需分项结论矛盾');
 row.manualReview=path;row.fullDeliveryPassed=review.fullDeliveryPassed;if(pair.module==='Q')row.targetRepairPassed=review.targetRepairPassed;
 const slot=state.slots.find((s:any)=>s.id===seal.id);if(slot.status==='manual_review_required')setSlot(state,seal.id,'judged',seal.artifactHash);else if(slot.status!=='judged')throw Error('槽位尚不能确认');
 reviews.push({id:seal.id,path,sha256:digestBytes(readFileSync(join(STUDY,path))),fullDeliveryPassed:review.fullDeliveryPassed,targetRepairPassed:review.targetRepairPassed});
}
const path=join(STUDY,'manual-review',id+'.json');if(existsSync(path))copyFileSync(path,join(STUDY,'manual-review',id+'-prior-'+Date.now()+'.json'));
save(path,{complete:reviews.every(r=>r.fullDeliveryPassed!==null),reviewComplete:true,hardBlocker:false,artifacts:Object.fromEntries(rows.map((r:any)=>[r.execution.id,r.execution.artifactHash])),reviews,time:new Date().toISOString()});
state.phase='running';state.updatedAt=new Date().toISOString();save(join(STUDY,'attribution.json'),state);console.log(JSON.stringify({pair:id,complete:true,results:reviews}));
