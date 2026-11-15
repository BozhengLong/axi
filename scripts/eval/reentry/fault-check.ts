import {join} from 'node:path';
import {existsSync,readFileSync,mkdirSync,readdirSync} from 'node:fs';
import {save,execute,docker} from '../core.ts';
import {taskFiles,file,snapshotHash} from '../v1/tasks.ts';
import {verifyExecution} from '../stable/execution.ts';
import {gradeInWorker} from './grading.ts';
import {STUDY,IMAGE,read} from './config.ts';
import {profile} from './profile.ts';
import {grade} from './grade.ts';
import {reference,fixture} from './tasks.ts';
import {GradingIndeterminate,testReport,passedTests} from './status.ts';
import {GradeWindow} from './window.ts';
import {isolated,cleanup} from './runtime.ts';
import {withResources} from './resources.ts';
const p=profile(),directory=join(STUDY,'fault-'+Date.now()),rows:any[]=[];let complete=false;
function check(name:string,passed:boolean,evidence:unknown){rows.push({name,passed,evidence});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({name,passed}));if(!passed)throw Error('故障校验失败:'+name)}
try{
 await withResources('fault-node-reports',async()=>{
  const window=new GradeWindow(Date.now()+60000),name='axi-trust-reports-'+Date.now();
  try{const r=await isolated(IMAGE,'V1-D',name,{
   'pass.test.mjs':file("import test from 'node:test';test('pass',()=>{});"),
   'fail.test.mjs':file("import test from 'node:test';import assert from 'node:assert/strict';test('behavior',()=>assert.equal(1,2));"),
   'syntax.test.mjs':file('const = broken;'),
   'timeout.test.mjs':file("import test from 'node:test';test('pending',async()=>{await new Promise(r=>setTimeout(r,1000))});"),
   'cancel.test.mjs':file("import test from 'node:test';test('pending',async()=>{await new Promise(()=>{})});"),
   'nested-cancel.test.mjs':file(fixture('oracle/D-test.mjs').split('import {setTimeout')[0]+"import {spawnSync} from 'node:child_process';test('Z01 pending',async()=>{await new Promise(()=>{})});"),
   'nested-timeout.test.mjs':file(fixture('oracle/D-test.mjs').split('import {setTimeout')[0]+"import {spawnSync} from 'node:child_process';test('Z01 pending',async()=>{await new Promise(r=>setTimeout(r,7000))});"),
  },window);
  for(const mode of ['pass','fail','syntax','timeout','cancel','nested-cancel','nested-timeout','empty','signal','supervisor']){
   const args=mode==='empty'?['node','-e','']:mode==='signal'?['bash','-lc','kill -TERM $$']:mode==='supervisor'?['node','-e','setInterval(()=>{},1000)']:['node','--test','--test-reporter=tap',...(mode==='timeout'?['--test-timeout=100']:[]),mode+'.test.mjs'];
   const result=await execute(r,args,undefined,true,mode==='supervisor'?150:window.remaining(mode));save(join(directory,mode+'.json'),result);
   let report:any,error:any;try{report=testReport(result,mode)}catch(e){error=e}
   const expected=['timeout','cancel','nested-cancel','nested-timeout','empty','signal','supervisor'].includes(mode);
   check('actual-'+mode,expected?error instanceof GradingIndeterminate:!error&&(mode==='pass'?passedTests(report):report.failed>0&&report.assertionFailure===(mode==='fail')),{result,origin:error?.origin,report});
   if(mode==='timeout'){let masked=false;try{testReport({...result,exitCode:0},'masked')}catch(e){masked=e instanceof GradingIndeterminate&&e.origin==='test_runner_timeout'}check('masked-timeout',masked,result)}
  }
  }finally{save(join(directory,'reports-cleanup.json'),await cleanup([name],window))}
 });
 for(const mode of ['cache','unknown','escape','deadline']){
  const id='trust-init-'+mode+'-'+Date.now(),candidate=reference('V1-E'),seed=taskFiles('V1-E'),before=snapshotHash(candidate),out=join(directory,mode);
  if(mode==='cache'||mode==='unknown')candidate[(mode==='cache'?'.tsimp':'unexpected-runtime')+'/daemon/socket']={type:'special',mode:0o755};
  if(mode==='escape')candidate['outside-link']={type:'symlink',mode:0o777,target:'/etc/passwd'};
  const snapshotBefore=snapshotHash(candidate);let result:any,error:any;
  try{result=await grade('V1-E',id,seed,candidate,out,{deadline:Date.now()+(mode==='deadline'?6000:900000)})}catch(e){error=e}
  const resources=[];for(const suffix of ['current','old'])for(const type of ['container','volume']){const r=await docker([type,'inspect','axi-v1-'+id+'-'+suffix],undefined,true);resources.push({suffix,type,gone:r.exitCode!==0&&/No such|not found/i.test(r.stderr)})}
  check('sandbox-'+mode,(mode==='cache'?result?.codePassed&&result.regressionPassed:error instanceof GradingIndeterminate)&&snapshotBefore===snapshotHash(candidate)&&resources.every(x=>x.gone),{origin:error?.origin,error:String(error??''),resources,originalHash:before,artifactUnchanged:snapshotBefore===snapshotHash(candidate)});
 }
 const pipeline=read(join(STUDY,'pipeline-latest.json'));if(!pipeline.complete||pipeline.executionProfileHash!==p.executionProfileHash)throw Error('先通过同版本CLI模拟');
 const row=pipeline.results[0],run=row.execution.runDirectory,seal=verifyExecution(run,p.executionProfileHash);
 for(const mode of ['expired','stale-expired','stale-worker-failed']){
  const target=join(directory,mode),scoreDir=join(target,'grades',p.graderRevision,seal.id);mkdirSync(scoreDir,{recursive:true,mode:0o700});
  if(mode.startsWith('stale'))save(join(scoreDir,'score.json'),row.score);
  if(mode==='stale-worker-failed')save(join(scoreDir,'attempt.json'),{deliberateExclusiveCollision:true});
  let error:any;try{await gradeInWorker(run,target,p.graderRevision,p.executionProfileHash,Date.now()+(mode==='stale-worker-failed'?10000:-1),'final',true)}catch(e){error=e}
  check(mode,error instanceof GradingIndeterminate&&verifyExecution(run,p.executionProfileHash).artifactHash===seal.artifactHash,{origin:error?.origin,artifactUnchanged:true});
 }
 const killedTarget=join(directory,'worker-cutoff');let killedError:any;
 try{await gradeInWorker(run,killedTarget,p.graderRevision,p.executionProfileHash,Date.now()+7000,'final',true)}catch(e){killedError=e}
 const failureFiles=readdirSync(killedTarget).filter(n=>n.endsWith('-worker-failure.json')),failure=failureFiles.length===1?read(join(killedTarget,failureFiles[0]!)):undefined;
 check('worker-cutoff-owned-cleanup',killedError instanceof GradingIndeterminate&&killedError.origin==='worker_deadline'&&failure?.reclaimed?.length===2&&failure.reclaimed.every((x:any)=>x.gone)&&failure.reclaimed.some((x:any)=>x.removed.stdout.includes(x.name))&&!existsSync(join(STUDY,'resource.lock')),{origin:killedError?.origin,failure});
 if(profile().sourceHash!==p.sourceHash)throw Error('故障校验期间源码变化');complete=true;
}finally{save(join(STUDY,'fault-latest.json'),{complete,directory,image:IMAGE,sourceHash:p.sourceHash,rows})}
