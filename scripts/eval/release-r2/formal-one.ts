import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {command,save} from '../core.ts';
import {verifiedHostEnvironment} from './host-environment.ts';
import {executeSubject} from './execute-subject.ts';
import {sha} from './source.ts';

const [studyArg]=process.argv.slice(2);assert(studyArg);const study=resolve(studyArg);
await verifiedHostEnvironment(study);
assert(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_API_KEY!=='synthetic-local-key','真实运行需要已配置的上游');
const control=async(action:string,payload:any={})=>JSON.parse((await command(['python3',join(import.meta.dir,'controller-gateway.py')],JSON.stringify({study,action,payload,mode:'real'}),false,620_000)).stdout);
const before=await control('status');assert(before.state.T1!==null,'尚未开始正式验收');
assert.equal(process.env.AXI_EVAL_IMAGE,before.state.identities.image,'运行镜像必须在启动前固定');
const claimed=await control('claim');const slot=claimed.claim.slot,out=join(study,'runs',slot.id);mkdirSync(out,{recursive:true});
assert(!existsSync(join(out,'controller-claim.json')),'不能重开已有槽');save(join(out,'controller-claim.json'),claimed);
const task=slot.task==='health'?join(study,'health'):join(study,slot.task.startsWith('C7-')?'c7':'tasks',slot.task);
const brief=slot.task==='health'||!slot.task.startsWith('C7-')?'eval/task.md':slot.task==='C7-L'?'c7/brief.md':'brief.md';
const prompt=readFileSync(join(task,'initial',brief),'utf8');save(join(out,'prompt.json'),{task:slot.task,source:brief,text:prompt});
try{
 const result=await executeSubject(study,slot.task,slot.product,slot.id.toLowerCase(),out,{prompt,claim:{mode:'real',id:slot.id}});
 save(join(out,'controller-seal.json'),await control('seal',{id:slot.id,output:out.slice(study.length+1)}));
 const graded=await command(['python3',join(import.meta.dir,'formal-grade.py'),study,slot.id],undefined,true,920_000);
 save(join(out,'grade-process.json'),graded);
 assert(graded.exitCode===0&&!graded.timedOut,'评分未在共享窗口内完成');
 const summary=JSON.parse(readFileSync(join(out,'grading-summary.json'),'utf8'));
 if(summary.views.some((v:any)=>v.gradeStatus!=='complete')){
  save(join(out,'grading-incident.json'),{reason:'评分结果不可信',summary});
  await control('pause',{reason:'measurement',incident:slot.id+'-grading',evidence:{path:join('runs',slot.id,'grading-incident.json'),sha256:sha(readFileSync(join(out,'grading-incident.json')))}});
 }
 console.log(JSON.stringify({slot:slot.id,executionStatus:result.execution.status,output:out,grading:summary,requiresIndependentReview:true}));
}catch(error){
 save(join(out,'incident.json'),{slot:slot.id,error:String(error),at:new Date().toISOString()});
 await control('pause',{reason:'execution-or-grading-failure',incident:slot.id,evidence:{path:join('runs',slot.id,'incident.json'),sha256:sha(readFileSync(join(out,'incident.json')))}}).catch(pause=>save(join(out,'pause-error.json'),{error:String(pause)}));
 throw error;
}
