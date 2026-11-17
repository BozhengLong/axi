import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {executeSubject} from './execute-subject.ts';
import {verifiedHostEnvironment} from '../release-r2/host-environment.ts';
import {snapshotFacility,verifyFacility} from './facility-snapshot.ts';
import {command,save} from '../core.ts';
import {sha} from '../release-r2/source.ts';
import {taskPrompt} from '../release-r2/task-prompt.ts';

const [studyArg,taskId,product,revision,ledgerLabel] = process.argv.slice(2);
assert(ledgerLabel && /^[a-zA-Z0-9-]+$/.test(ledgerLabel));
assert(studyArg && /^(health|U\d\d|C7-[LO])$/.test(taskId!) && ['v0','v1','claude'].includes(product!) && /^[a-zA-Z0-9-]+$/.test(revision!));
assert(process.env.ANTHROPIC_API_KEY==='synthetic-local-key','模拟入口必须使用合成认证配置');
assert(process.env.ANTHROPIC_BASE_URL==='http://127.0.0.1:1','模拟入口必须使用本地无上游配置');
const study=resolve(studyArg),auth=JSON.parse(readFileSync(join(study,'authorization.json'),'utf8'));
const qualificationWindow=JSON.parse((await command(['python3',join(import.meta.dir,'qualification_guard.py'),study,taskId!])).stdout);assert(Date.now()<Date.parse(qualificationWindow.deadline));
await verifiedHostEnvironment(study);
const task=taskId==='health'?join(study,'health'):join(study,taskId!.startsWith('C7-')?'c7':'tasks',taskId!),profile=JSON.parse(readFileSync(join(task,'qualification-profile.json'),'utf8'));
assert.equal(process.env.AXI_EVAL_IMAGE,profile.image);
const out=join(task,`pipeline-${product}-${revision}`);mkdirSync(out);
const publicPrompt=taskPrompt(task,taskId!);save(join(out,'prompt.json'),publicPrompt);
assert(readFileSync(join(task,'grading-profile.json'),'utf8'),'评分配置必须在运行前固定');
const label=ledgerLabel;
// 恢复轮使用同一账本真实claim，不另造前序或重置时间。
const claimProcess=await command(['python3',join(import.meta.dir,'controller-gateway.py')],JSON.stringify({study,action:'claim',mode:'mock',payload:{ledgerLabel:label}}));
const claim=JSON.parse(claimProcess.stdout).claim;assert.equal(claim.slot.task,taskId);assert.equal(claim.slot.product,product);save(join(out,'controller-claim.json'),claim);
const controller=(action:string,payload:any)=>command(['python3',join(import.meta.dir,'controller-gateway.py')],JSON.stringify({study,action,mode:'mock',payload:{ledgerLabel:label,...payload}}));
const frozen=snapshotFacility(task,out);
const patch:Record<string,string>=JSON.parse(readFileSync(join(task,profile.references[0]+'-patch.json'),'utf8'));
// 模拟API只发送普通工具参数；题目卷内不挂参考答案或私有验收材料。
const publicArgs=(args:string[])=>{
 let result=[...args];if(result[1]==='/reporters/tap-run.mjs')result=result.slice(2);
 return result.filter((v,i,a)=>!v.startsWith('--reporter=')&&!v.startsWith('--reporters=')&&!v.startsWith('--test-reporter=')&&!v.startsWith('--reporter-outfile=')&&v!=='--preload'&&a[i-1]!=='--preload'&&v!=='--reporter'&&a[i-1]!=='--reporter');
};
const steps=profile.commands.filter((x:any)=>x.label!=='target').map((x:any)=>({label:x.label,args:publicArgs(x.args)}));
if(taskId!=='health'&&!steps.some((x:any)=>x.label==='regression')){
 const selected=profile.counterfactualCommands.find((x:any)=>x.label==='regression');assert(selected);steps.push({label:'regression',args:publicArgs(selected.args)});
}
function shellTool(id:string,changes:Record<string,string>,validate:boolean){
 const data=gzipSync(JSON.stringify({changes,steps:validate?steps:[],taskDocument:{path:publicPrompt.source,sha256:publicPrompt.sha256}})).toString('base64');
 const js=`const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),cp=require('node:child_process'),crypto=require('node:crypto');const payload=JSON.parse(z.gunzipSync(Buffer.from(${JSON.stringify(data)},'base64')).toString());const brief=fs.readFileSync(payload.taskDocument.path);if(crypto.createHash('sha256').update(brief).digest('hex')!==payload.taskDocument.sha256)throw Error('task document mismatch');process.stdout.write(brief);console.log('MOCK_TASK_DOCUMENT_READ '+payload.taskDocument.sha256);for(const[n,v]of Object.entries(payload.changes)){fs.mkdirSync(path.dirname(n),{recursive:true});fs.writeFileSync(n,v)}const rows=[];for(const s of payload.steps){const p=cp.spawnSync(s.args[0],s.args.slice(1),{encoding:'utf8',maxBuffer:128*1024*1024,timeout:540000});rows.push({...s,status:p.status,signal:p.signal,error:p.error?.message,stdout:p.stdout,stderr:p.stderr});fs.writeFileSync('/tmp/axi-pipeline-checks.json',JSON.stringify(rows));process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');if(p.status!==0||p.signal||p.error)process.exit(1)}console.log('MOCK_TOOL_COMPLETED');`;
 const shell="node -e '"+js.replaceAll("'","'\"'\"'")+"'";assert(Buffer.byteLength(shell)<96000,'模拟命令过大');
 return {content:[{type:'tool_use',id,name:product==='claude'?'Bash':'bash',input:{command:shell,...(product==='claude'?{timeout:600000}:{timeout_ms:600000})}}],stopReason:'tool_use'};
}
const end=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'});
const firstTest=taskId==='health'?'result.txt':profile.regressionPaths[0];assert(patch[firstTest]);
const mock=[shellTool('read_task',{},false),...(product==='v1'?[shellTool('draft',{[firstTest]:patch[firstTest]!},false),end('模拟初稿，需要收尾复核。'),shellTool('complete',patch,true),end('模拟参考完成；不计入模型能力。')]:[shellTool('complete',patch,true),end('模拟参考完成；不计入模型能力。')])];
try {
const x=await executeSubject(study,taskId!,product as 'v0'|'v1'|'claude',`${taskId!.toLowerCase()}-${product}-${revision}`,out,{mock,claim:{mode:'mock',id:claim.id,ledgerLabel:label},prompt:publicPrompt.text});
save(join(out,'controller-seal.json'),JSON.parse((await controller('seal',{id:claim.id,output:out.slice(study.length+1)})).stdout));
assert.equal(x.execution.status,'completed',x.execution.error??'');assert.equal(x.checks.length,steps.length);assert(x.checks.every((c:any)=>c.status===0&&!c.signal&&!c.error));assert.equal(!!x.checkpoint,product==='v1');

const gradeStart=performance.now();
const graded=await command(['python3',join(import.meta.dir,'formal-grade.py'),study,claim.id,'--mock-ledger',label],undefined,true,taskId==='health'?305000:905000);
save(join(out,'grade-process.json'),graded);assert.equal(graded.exitCode,0);assert(!graded.timedOut);
const grading=JSON.parse(readFileSync(join(out,'grading-summary.json'),'utf8'));
const finalGrade=JSON.parse(readFileSync(join(out,'final-grade/result.json'),'utf8'));
assert(finalGrade.automaticChecksPassed,JSON.stringify(finalGrade));
if(x.checkpoint){const checkpointGrade=JSON.parse(readFileSync(join(out,'checkpoint-grade/result.json'),'utf8'));assert(checkpointGrade.gradeStatus==='complete'&&(taskId==='health'?checkpointGrade.codePassed:!checkpointGrade.codePassed),'检查点实际状态不符');}
assert(performance.now()-gradeStart<=(taskId==='health'?240000:720000));
assert.deepEqual(grading.views.map((v:any)=>v.view),['final',...(x.checkpoint?['checkpoint']:[])]);
const execEvidence=JSON.parse(readFileSync(join(out,'execution-evidence.json'),'utf8'));
save(join(out,'review.json'),{artifactHash:sha(readFileSync(join(out,'final-snapshot.json'))),executionHash:execEvidence.executionHash,gradeHash:sha(readFileSync(join(out,'final-grade/result.json'))),reviewer:'R3 scripted reference pipeline qualification',classification:'PASS',mockOnly:true,checks:{publicContract:true,sourceChanges:true,userChanges:true,documentationExample:true,reportedChecks:true,traceIntegrity:true}});
const reviewed=JSON.parse((await controller('review',{id:claim.id,output:out.slice(study.length+1)})).stdout);assert(reviewed.reviewed&&reviewed.classification==='PASS'&&!reviewed.paused);save(join(out,'controller-review.json'),reviewed);
save(join(out,'result.json'),{qualified:true,mockOnly:true,task:taskId,product,executionStatus:x.execution.status,requests:x.execution.proxy.meter.forwardedGeneration,traceDirectory:x.traceDirectory,finalArtifact:sha(readFileSync(join(out,'final-snapshot.json'))),gradingMs:performance.now()-gradeStart,checkpointCaptured:!!x.checkpoint});
console.log(JSON.stringify({task:taskId,product,qualified:true,traceDirectory:x.traceDirectory}));

} finally { verifyFacility(frozen,out); }
