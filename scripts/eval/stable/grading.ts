import{join}from'node:path';
import{mkdirSync,readdirSync,readFileSync,existsSync}from'node:fs';
import{grade}from'../v1/grade.ts';
import{command,execute,docker,save}from'../core.ts';
import{isolated}from'../v1/runtime.ts';
import{assertVerificationCompleted}from'../v1/verification-status.ts';
import{gradeDiagnostics}from'../v1/grade-diagnostics.ts';
import{verifyExecution,exclusive}from'./execution.ts';
import{profile,digestBytes}from'./profile.ts';
import{authorization,read,IMAGE}from'./config.ts';

export async function gradeArtifact(run:string,target:string,revision:string,expectedProfile:string,options:{deadline?:number;simulateTimeout?:boolean}={}){
 const p=profile();if(p.graderRevision!==revision)throw Error('评分源码与指定版本不符');
 const seal=verifyExecution(run,expectedProfile),a=authorization();
 const directory=join(target,'grades',revision,seal.id);mkdirSync(join(target,'grades',revision),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});
 exclusive(join(directory,'attempt.json'),{id:seal.id,artifactHash:seal.artifactHash,revision,executionProfileHash:expectedProfile,started:new Date().toISOString(),sourceHash:p.sourceHash});
 const start=Date.now();let result:any;
 try{
  if(options.simulateTimeout){
   const r=await isolated(IMAGE,seal.task,'fault-'+Date.now(),read(join(run,'initial-files.json')));
   try{const x=await execute(r,['node','-e','setInterval(()=>{},1000)'],undefined,true,50);save(join(directory,'injected-command.json'),x);assertVerificationCompleted(x,'injected-timeout')}catch(error){await gradeDiagnostics(r.name,directory);throw error}finally{await r.close()}
  }
  const g=await grade(IMAGE,seal.task,`stable-${Date.now()}-${seal.id}`,read(join(run,'initial-files.json')),read(join(run,'final-files.json')),directory,{executionStatus:seal.executionStatus,git:read(join(run,'final-git.json')),initialGit:read(join(run,'initial-git.json')),deadline:Math.min(options.deadline??a.workDeadline,a.workDeadline)});
  result={gradeStatus:'complete',codePassed:g.codePassed,regressionPassed:g.regressionPassed,fullDeliveryPassed:null,failureChecks:g.checks.filter(c=>!c.pass).map(c=>c.id)};
 }catch(error){result={gradeStatus:'indeterminate',codePassed:null,regressionPassed:null,fullDeliveryPassed:null,error:String(error)}}
 // 评分不得写回候选证据；即使评分失败仍核对原封存记录。
 verifyExecution(run,expectedProfile);
 const files:Record<string,string>={};const walk=(d:string,rel='')=>{for(const e of readdirSync(d,{withFileTypes:true})){const n=rel+e.name;if(e.isDirectory())walk(join(d,e.name),n+'/');else if(e.isFile())files[n]=digestBytes(readFileSync(join(d,e.name)));else throw Error('评分目录含非普通文件')}};walk(directory);
 const score={id:seal.id,artifactHash:seal.artifactHash,executionStatus:seal.executionStatus,executionProfileHash:expectedProfile,graderRevision:revision,sourceHash:p.sourceHash,elapsedMs:Date.now()-start,...result,files};
 exclusive(join(directory,'score.json'),score);return {...score,scorePath:join(directory,'score.json')};
}
export async function gradeInWorker(run:string,target:string,revision:string,executionProfileHash:string,deadline:number){
 const seal=verifyExecution(run,executionProfileHash),directory=join(target,'grades',revision,seal.id);
 const x=await command(['bun','scripts/eval/stable/grade-one.ts','--offline'],JSON.stringify({run,target,revision,executionProfileHash,deadline}),true,17*60000);
 if(x.exitCode||x.timedOut){
  mkdirSync(directory,{recursive:true,mode:0o700});const failure={id:seal.id,artifactHash:seal.artifactHash,executionStatus:seal.executionStatus,executionProfileHash,graderRevision:revision,gradeStatus:'indeterminate',codePassed:null,regressionPassed:null,fullDeliveryPassed:null,error:'grader_process_failure',process:x};
  const scorePath=join(directory,'worker-failure.json');exclusive(scorePath,failure);verifyExecution(run,executionProfileHash);return {...failure,scorePath};
 }
 const scorePath=join(directory,'score.json');if(!existsSync(scorePath))throw Error('评分子进程未写入结果');
 const score=read(scorePath);if(score.artifactHash!==seal.artifactHash||score.graderRevision!==revision)throw Error('评分结果身份不符');
 return {...score,scorePath};
}
if(import.meta.main)throw Error('请使用grade-one.ts入口');
