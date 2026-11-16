import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {executeSubject} from './execute-subject.ts';
import {command,save} from '../core.ts';
import {sha} from './source.ts';

const [studyArg,taskId,product,revision] = process.argv.slice(2);
assert(studyArg && /^(T\d\d|C7-[LO])$/.test(taskId!) && ['v0','v1','claude'].includes(product!) && /^[a-zA-Z0-9-]+$/.test(revision!));
assert.equal(process.env.ANTHROPIC_API_KEY,'synthetic-local-key');
assert.equal(process.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');
const study=resolve(studyArg),auth=JSON.parse(readFileSync(join(study,'authorization.json'),'utf8'));
assert.equal(auth.T1,null); assert(Date.now()<Date.parse(auth.preparationDeadline));
const task=join(study,taskId!.startsWith('C7-')?'c7':'tasks',taskId!),profile=JSON.parse(readFileSync(join(task,'qualification-profile.json'),'utf8'));
assert.equal(process.env.AXI_EVAL_IMAGE,profile.image);
const out=join(task,`pipeline-${product}-${revision}`);mkdirSync(out);
const patch=JSON.parse(readFileSync(join(task,profile.references[0]+'-patch.json'),'utf8'));
// 模拟API只发送普通工具参数；题目卷内不挂参考答案或私有验收材料。
const publicArgs=(args:string[])=>{
 let result=[...args];if(result[1]==='/reporters/tap-run.mjs')result=result.slice(2);
 return result.filter((v,i,a)=>!v.startsWith('--reporter=')&&!v.startsWith('--reporters=')&&!v.startsWith('--test-reporter=')&&!v.startsWith('--reporter-outfile=')&&v!=='--preload'&&a[i-1]!=='--preload'&&v!=='--reporter'&&a[i-1]!=='--reporter');
};
const steps=profile.commands.filter((x:any)=>x.label!=='target').map((x:any)=>({label:x.label,args:publicArgs(x.args)}));
if(!steps.some((x:any)=>x.label==='regression')){
 const selected=profile.counterfactualCommands.find((x:any)=>x.label==='regression');assert(selected);steps.push({label:'regression',args:publicArgs(selected.args)});
}
function shellTool(id:string,changes:Record<string,string>,validate:boolean){
 const data=gzipSync(JSON.stringify({changes,steps:validate?steps:[]})).toString('base64');
 const js=`const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),cp=require('node:child_process');const payload=JSON.parse(z.gunzipSync(Buffer.from(${JSON.stringify(data)},'base64')).toString());for(const[n,v]of Object.entries(payload.changes)){fs.mkdirSync(path.dirname(n),{recursive:true});fs.writeFileSync(n,v)}const rows=[];for(const s of payload.steps){const p=cp.spawnSync(s.args[0],s.args.slice(1),{encoding:'utf8',maxBuffer:128*1024*1024,timeout:540000});rows.push({...s,status:p.status,signal:p.signal,error:p.error?.message,stdout:p.stdout,stderr:p.stderr});fs.writeFileSync('/tmp/axi-pipeline-checks.json',JSON.stringify(rows));process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');if(p.status!==0||p.signal||p.error)process.exit(1)}console.log('MOCK_TOOL_COMPLETED');`;
 const shell="node -e '"+js.replaceAll("'","'\"'\"'")+"'";assert(Buffer.byteLength(shell)<96000,'模拟命令过大');
 return {content:[{type:'tool_use',id,name:product==='claude'?'Bash':'bash',input:{command:shell,...(product==='claude'?{timeout:600000}:{timeout_ms:600000})}}],stopReason:'tool_use'};
}
const end=(text:string)=>({content:[{type:'text',text}],stopReason:'end_turn'});
const firstTest=profile.regressionPaths[0];assert(patch[firstTest]);
const mock=product==='v1'?[shellTool('draft',{[firstTest]:patch[firstTest]},false),end('模拟初稿，需要收尾复核。'),shellTool('complete',patch,true),end('模拟参考完成；不计入模型能力。')]:[shellTool('complete',patch,true),end('模拟参考完成；不计入模型能力。')];
const x=await executeSubject(study,taskId!,product as 'v0'|'v1'|'claude',`${taskId!.toLowerCase()}-${product}-${revision}`,out,{mock,prompt:'这是离线CLI流程资格。按当前公开任务完成修改和验证。模拟响应不计模型能力。'});
assert.equal(x.execution.status,'completed',x.execution.error);assert.equal(x.checks.length,steps.length);assert(x.checks.every((c:any)=>c.status===0&&!c.signal&&!c.error));assert.equal(!!x.checkpoint,product==='v1');
save(join(out,'grading-profile-process.json'),await command(['python3',join(import.meta.dir,'prepare-grading-profile.py'),study,taskId!]));
const gradeStart=performance.now();let finalGrade:any,checkpointGrade:any;
for(const view of ['final',...(x.checkpoint?['checkpoint']:[])]){
 const seconds=(720_000-(performance.now()-gradeStart))/1000;assert(seconds>0);
 const process=await command(['python3',join(import.meta.dir,'grade-artifact.py'),study,taskId!,join(out,view+'-snapshot.json'),join(out,view+'-grade'),String(seconds),'--development'],undefined,true,Math.ceil(seconds*1000)+5000);
 save(join(out,view+'-grade-process.json'),process);const g=JSON.parse(readFileSync(join(out,view+'-grade/result.json'),'utf8'));if(view==='final')finalGrade=g;else checkpointGrade=g;
}
assert(finalGrade.automaticChecksPassed,JSON.stringify(finalGrade));if(x.checkpoint)assert(checkpointGrade.gradeStatus==='complete'&&!checkpointGrade.codePassed,'复核检查点应为真实未完成产物');assert(performance.now()-gradeStart<=720_000);
save(join(out,'result.json'),{qualified:true,mockOnly:true,task:taskId,product,executionStatus:x.execution.status,requests:x.execution.proxy.budget.generationRequests,traceDirectory:x.traceDirectory,finalArtifact:sha(readFileSync(join(out,'final-snapshot.json'))),gradingMs:performance.now()-gradeStart,checkpointCaptured:!!x.checkpoint});
console.log(JSON.stringify({task:taskId,product,qualified:true,traceDirectory:x.traceDirectory}));
