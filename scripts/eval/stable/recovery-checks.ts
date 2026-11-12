import{join,dirname}from'node:path';
import{mkdirSync,copyFileSync,unlinkSync,readFileSync}from'node:fs';
import{save}from'../core.ts';
import{grade}from'../v1/grade.ts';
import{taskFiles}from'../v1/tasks.ts';
import{authorization,STUDY,IMAGE,read}from'./config.ts';
import{profile,digestBytes}from'./profile.ts';
import{verifyExecution}from'./execution.ts';
import{gradeArtifact}from'./grading.ts';
import{recoveryDecision,nextAfterGrade,regradeAll,type RecoveryContext}from'./recovery.ts';
if(process.argv[2]!=='--mock')throw Error('需要 --mock');
const a=authorization(),p=profile(),pipeline=read(join(STUDY,'pipeline-latest.json')),run=pipeline.results[0]?.execution.runDirectory;
if(!pipeline.complete||pipeline.sourceHash!==p.sourceHash||pipeline.results.length!==24||!run)throw Error('需要当前完整24次模拟');
const seal=verifyExecution(run,p.executionProfileHash),before=JSON.stringify(seal),directory=join(STUDY,'recovery-checks-'+Date.now()),results:any[]=[];let complete=false;
const good:RecoveryContext={used:false,executionMatches:true,oracleMatches:true,evidenceComplete:true,semanticsReviewed:true,calibrationPassed:true,faultChecksPassed:true,remainingMs:a.deadlineMs-Date.now(),completed:1};
function check(name:string,passed:boolean,evidence:unknown){results.push({name,passed,evidence,newModelCalls:0});save(join(directory,'results.json'),results);if(!passed)throw Error(name)}
try{
 const interrupted=await gradeArtifact(run,join(directory,'timeout'),p.graderRevision,p.executionProfileHash,{simulateTimeout:true});
 const repaired=await regradeAll([run],r=>gradeArtifact(r,join(directory,'repaired'),p.graderRevision,p.executionProfileHash),(_r,s)=>save(join(directory,'repaired-score.json'),s));
 const diagnostics=read(join(directory,'timeout','grades',p.graderRevision,seal.id,'diagnostics.json'));
 check('交付后评分挂起可恢复既有产物',interrupted.executionStatus==='completed'&&interrupted.gradeStatus==='indeterminate'&&diagnostics.checks.length===3&&diagnostics.checks.every((x:any)=>x.result?.exitCode===0)&&recoveryDecision(good).allowed&&repaired[0].codePassed&&repaired[0].regressionPassed&&JSON.stringify(verifyExecution(run,p.executionProfileHash))===before,{interrupted,repaired,diagnostics});
 const seed=taskFiles('V1-A'),ordinary=await grade(IMAGE,'V1-A','ordinary-'+Date.now(),seed,seed,join(directory,'ordinary'),{deadline:a.workDeadline});
 check('普通断言失败不补跑',!ordinary.codePassed&&nextAfterGrade('complete',false)==='continue',{failed:ordinary.checks.filter(c=>!c.pass).map(c=>c.id)});
 const clone=join(directory,'missing',seal.id);mkdirSync(clone,{recursive:true,mode:0o700});for(const file of [...Object.keys(seal.files),'execution-seal.json']){const dest=join(clone,file);mkdirSync(dirname(dest),{recursive:true,mode:0o700});copyFileSync(join(run,file),dest)}unlinkSync(join(clone,'final-files.json'));let rejected=false;try{verifyExecution(clone,p.executionProfileHash)}catch{rejected=true}
 check('证据缺失拒绝恢复',rejected&&!recoveryDecision({...good,evidenceComplete:false}).allowed,{rejected});
 let mismatch=false;try{verifyExecution(run,'different-profile')}catch{mismatch=true}check('执行profile改变拒绝恢复',mismatch&&!recoveryDecision({...good,executionMatches:false}).allowed,{mismatch});
 check('第二次评分异常停止',!recoveryDecision({...good,used:true}).allowed&&nextAfterGrade('indeterminate',true)==='stop',{});
 check('截止不足不启动重评',!recoveryDecision({...good,remainingMs:1000}).allowed,{});complete=true;
}finally{const report={complete,image:IMAGE,directory,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,results};save(join(directory,'report.json'),report);save(join(STUDY,'recovery-checks-latest.json'),report)}
console.log(JSON.stringify({complete,checks:results.length}));
