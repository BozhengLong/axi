import {join} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {ROOT,save,execute} from '../core.ts';
import {file} from '../v1/tasks.ts';
import {digestBytes} from '../stable/profile.ts';
import {verifyExecution} from '../stable/execution.ts';
import {profile,revisionFor} from './profile.ts';
import {STUDY,IMAGE,read,authorization,pairs,developmentSchedule} from './config.ts';
import {fixture,reference} from './tasks.ts';
import {runSentinels} from './sentinel.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {withResources} from './resources.ts';
import {freshState,nextSlot,openIssue,verifyIsolation,closeIssue,beginRepair,completeRepair,attributionStatus,setSlot} from './modules.ts';
import {scopesFor} from './dependency-scope.ts';
import {testReport,GradingIndeterminate} from './status.ts';
import {gradeInWorker} from './grading.ts';
const a=authorization(),p=profile(),directory=join(STUDY,'module-fault-'+Date.now()),rows:any[]=[];let complete=false;
const check=(name:string,passed:boolean,evidence:unknown)=>{rows.push({name,passed,evidence});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({name,passed}));if(!passed)throw Error('模块故障演练失败:'+name)};
const mapPath=join(ROOT,'evals/specs/v1-attribution-followup-v1/dependency-map.json'),mapHash=digestBytes(readFileSync(mapPath));
try{
 const sentinels=await runSentinels(['Q','D','E'],join(directory,'sentinels'));
 const bad=await withResources('fault-local-E',async()=>{
  const window=new GradeWindow(Math.min(Date.now()+900000,a.workDeadline)),name='axi-followup-local-e-'+Date.now(),seed=reference('V1-E','primary',false);
  const normal=fixture('oracle/E-waiting.mjs'),broken=normal.replace("assert.deepEqual(result,{kind:'value',value:1})","assert.deepEqual(result,{kind:'value',value:2})");
  if(broken===normal)throw Error('错误预期注入位置未找到');seed['eval-oracle/broken.test.mjs']=file(broken);
  try{const r=await isolated(IMAGE,'V1-E',name,seed,window),build=await execute(r,['bash','-lc','npm run build'],undefined,true,window.remaining('build'));if(build.exitCode)throw Error('正例构建失败');
   const measured=await execute(r,['node','--test','--test-reporter=tap','eval-oracle/broken.test.mjs'],undefined,true,window.remaining('measure'));save(join(directory,'E-broken-expectation.json'),measured);return testReport(measured,'E-broken');
  }finally{save(join(directory,'E-cleanup.json'),await cleanup([name],window))}
 });
 const s=freshState(developmentSchedule,pairs),openedAt=Date.now(),repro='E-broken-expectation.json';
 openIssue(s,{id:'bad-E',scope:'E',kind:'contract',reason:'injected wrong E expectation rejects legal reference',openedAt});
 check('E-fault-pauses-with-real-failed-reference',bad.failed>0&&bad.assertionFailure&&nextSlot(s)===undefined,{failed:bad.failed,scope:scopesFor('evals/v1-attribution-followup-v1/oracle/E-waiting.mjs.fixture')});
 const proof={incident:'bad-E',dependencyMapHash:mapHash,reproduction:repro,reproductionHash:digestBytes(readFileSync(join(directory,repro))),sentinels:sentinels.rows.filter(x=>x.module==='D'),recordedAt:Date.now()};
 verifyIsolation(s,'bad-E',proof,mapHash,p.moduleGraderRevisions,Date.now());closeIssue(s,'bad-E');
 check('D-continues-E-and-Q-remain-incomplete',nextSlot(s)?.id==='D1-axi'&&s.modules.E.status==='closed'&&s.modules.Q.status==='closed'&&attributionStatus(s,true,true)==='A-INCOMPLETE',s);
 const badD=await withResources('fault-local-D',async()=>{
  const window=new GradeWindow(Math.min(Date.now()+900000,a.workDeadline)),name='axi-followup-local-d-'+Date.now(),seed=reference('V1-D','primary',false);
  const normal=fixture('oracle/D-test.mjs'),needle="test('D01 validation and explicit versus legacy input arguments',async()=>{";
  if(!normal.includes(needle))throw Error('D局部错误注入位置缺失');seed['eval-oracle/broken.test.mjs']=file(normal.replace(needle,needle+"assert.fail('injected wrong D expectation');"));
  try{const r=await isolated(IMAGE,'V1-D',name,seed,window),measured=await execute(r,['node','--test','--test-reporter=tap','eval-oracle/broken.test.mjs'],undefined,true,window.remaining('measure'));save(join(directory,'D-broken-expectation.json'),measured);return testReport(measured,'D-broken')}
  finally{save(join(directory,'D-cleanup.json'),await cleanup([name],window))}
 });
 check('D-local-fault-has-task-local-evidence',badD.failed===1&&/^not ok \d+ - D01 /m.test(badD.stdout)&&JSON.stringify(scopesFor('evals/v1-attribution-followup-v1/oracle/D-test.mjs.fixture'))===JSON.stringify(['D']),{failed:badD.failed});
 const dRow=sentinels.rows.find(x=>x.module==='D')!,dReport=read(join(STUDY,dRow.report)),dGrade=read(join(STUDY,dReport.cases[0].gradeFile));
 let parserError:any;try{testReport({...dGrade.logs.contract,stdout:dGrade.logs.contract.stdout.replace('# tests 22','# tests 23')},'injected-common-parser-report')}catch(error){parserError=error}
 const common=freshState(developmentSchedule,pairs);openIssue(common,{id:'parser',scope:'common',kind:'measurement',reason:String(parserError),openedAt:Date.now()});
 check('common-report-fault-blocks-all',parserError instanceof GradingIndeterminate&&nextSlot(common)===undefined&&scopesFor('scripts/eval/attribution-followup/status.ts').length===3,{origin:parserError?.origin});
 const pipeline=read(join(STUDY,'pipeline-latest.json'));if(!pipeline.complete)throw Error('先完成实际CLI模拟');
 const item=pipeline.results.find((x:any)=>x.task==='V1-D'&&x.product==='axi'),seal=verifyExecution(item.execution.runDirectory,p.executionProfileHash);
 const corrupt=join(directory,'corrupt-seal');mkdirSync(corrupt,{recursive:true});writeFileSync(join(corrupt,'execution-seal.json'),JSON.stringify({...seal,classification:'changed'}));
 let damaged=false;try{verifyExecution(corrupt,p.executionProfileHash)}catch{damaged=true}
 const unsafe=freshState(developmentSchedule,pairs);setSlot(unsafe,'Q1-axi','running');setSlot(unsafe,'Q1-axi','sealed',seal.artifactHash);openIssue(unsafe,{id:'seal',scope:'common',kind:'safety',reason:'seal corruption',openedAt:Date.now()});
 check('seal-corruption-stops-all-and-preserves-original',damaged&&unsafe.global==='closed'&&nextSlot(unsafe)===undefined&&verifyExecution(item.execution.runDirectory).artifactHash===seal.artifactHash,{originalArtifactHash:seal.artifactHash});
 const repaired=freshState(developmentSchedule,pairs);openIssue(repaired,{id:'d',scope:'D',kind:'measurement',reason:'synthetic local measurement state',openedAt:Date.now()});beginRepair(repaired,'d',Date.now(),a.workDeadline);
 let incompleteRejected=false;try{completeRepair(repaired,'d',Date.now(),{sameContract:true,sameExecution:true,qualified:true,allAffectedViewsRegraded:false})}catch{incompleteRejected=true}
 const scores=[];const deadline=Math.min(Date.now()+900000,a.workDeadline);
 for(const scope of ['final','checkpoint']as const)scores.push(await gradeInWorker(item.execution.runDirectory,join(directory,'recovery'),revisionFor(p,'V1-D'),p.executionProfileHash,deadline,scope,true));
 const bound=scores.every(score=>score.gradeStatus==='complete'&&score.artifactHash===seal.artifactHash)&&scores.length===2;
 completeRepair(repaired,'d',Date.now(),{sameContract:true,sameExecution:true,qualified:true,allAffectedViewsRegraded:bound});
 check('real-sealed-final-and-checkpoint-recovery',incompleteRejected&&bound&&repaired.modules.D.status==='active',{scores,modelRuns:0,scope:'实际评分worker及生产控制函数；临时状态，不消耗真实研究修复额度'});
 openIssue(repaired,{id:'second',scope:'D',kind:'measurement',reason:'second independent error',openedAt:Date.now()});let secondRejected=false;try{beginRepair(repaired,'second',Date.now(),a.workDeadline)}catch{secondRejected=true}
 verifyIsolation(repaired,'second',{...proof,incident:'second',reproduction:'D-broken-expectation.json',reproductionHash:digestBytes(readFileSync(join(directory,'D-broken-expectation.json'))),recordedAt:Date.now(),sentinels:sentinels.rows.filter(x=>x.module!=='D')},mapHash,p.moduleGraderRevisions,Date.now());closeIssue(repaired,'second');
 check('second-fault-cannot-repair-D-unrelated-Q-continues',secondRejected&&repaired.modules.D.status==='closed'&&nextSlot(repaired)?.id==='Q1-axi',repaired);
 if(profile().sourceHash!==p.sourceHash)throw Error('模块演练期间源码改变');complete=true;
}finally{save(join(STUDY,'module-fault-latest.json'),{complete,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,directory,rows,modelCalls:0})}
