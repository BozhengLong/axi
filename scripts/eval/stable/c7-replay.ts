import{join}from'node:path';
import{save}from'../core.ts';
import{grade}from'../v1/grade.ts';
import{profile}from'./profile.ts';
import{authorization,STUDY,IMAGE,read}from'./config.ts';
import{digestBytes}from'./profile.ts';
import{readFileSync}from'node:fs';
if(process.argv[2]!=='--offline')throw Error('需要 --offline');
const a=authorization(),p=profile(),old='/Users/spidey0o0zheng/.local/share/axi-evals/v1-20261112',reviews=read(join(old,'reviews.json')),directory=join(STUDY,'c7-replay-'+Date.now()),results:any[]=[];
let complete=false;
try{for(const review of reviews.filter((x:any)=>x.id.includes('C7-'))){
 const batch=review.originDirectory??read(join(old,'formal-batch.json')).directory,run=join(batch,review.id),input=read(join(run,'input.json')),trace=read(join(run,'trace-manifest.json'));
 if(trace.status!=='complete_observable'||review.fullDeliveryPassed!==true)throw Error('历史C7证据不完整');
 for(const f of trace.files)if(digestBytes(readFileSync(join(run,f.path)))!==f.sha256)throw Error('历史C7原始证据改变');
 const result=await grade(IMAGE,input.task,'c7-history-'+Date.now(),read(join(run,'initial-files.json')),read(join(run,'final-files.json')),join(directory,input.task),{executionStatus:read(join(run,'execution.json')).status,initialGit:read(join(run,'initial-git.json')),git:read(join(run,'final-git.json')),deadline:a.workDeadline});
 const passed=result.codePassed&&result.regressionPassed;results.push({task:input.task,originDirectory:run,historicalExecution:true,newModelCalls:0,passed});if(!passed)throw Error('历史C7在新环境未通过');
 }if(results.length!==2)throw Error('历史C7数量不符');complete=true;
}finally{const report={complete,directory,image:IMAGE,sourceHash:p.sourceHash,results};save(join(directory,'results.json'),report);save(join(STUDY,'c7-replay-latest.json'),report)}
