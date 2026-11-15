import {join} from 'node:path';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {executableOracle} from './measurement.ts';
import {ROOT,save,execute,docker,type Snapshot} from '../core.ts';
import {clean,file,contents,taskManifest} from '../v1/tasks.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {withResources} from './resources.ts';
import {GradingIndeterminate,classifyCommand,testReport,passedTests} from './status.ts';
import {changedJS} from '../rc/quality.ts';
import {fixture} from './tasks.ts';
import {IMAGE,type DevTask} from './config.ts';
import type {GitState} from '../c7/grade.ts';
async function gradeOwned(task:DevTask,id:string,seed:Snapshot,candidate:Snapshot,directory:string,options:{executionStatus?:string;git?:GitState;initialGit?:GitState;regression?:boolean;deadline?:number;upstream?:boolean;manifest?:any}={}){
 const start=Date.now(),deadline=Math.min(start+15*60000,options.deadline??Infinity),window=new GradeWindow(deadline),checks:{id:string;pass:boolean;status:'passed'|'failed';actual:unknown}[]=[],logs:Record<string,unknown>={};
 let expired=false;const names=[`axi-v1-${id}-current`,`axi-v1-${id}-old`];
 const check=(id:string,pass:boolean,actual:unknown)=>checks.push({id,pass,status:pass?'passed':'failed',actual});
 const remaining=(stage:string)=>window.remaining(stage);
 const manifest=options.manifest??taskManifest(task),protectedPaths:string[]=manifest.protected;
 check('DELIVERY',(options.executionStatus??'completed')==='completed',options.executionStatus??'completed');
 const changed=protectedPaths.filter(p=>JSON.stringify(seed[p])!==JSON.stringify(candidate[p]));check('PROTECT',changed.length===0,changed);
 if(options.git&&options.initialGit){const g=options.git,lines=g.status.trimEnd().split('\n').filter(Boolean);check('GIT',g.valid&&g.head===options.initialGit.head&&lines.every(l=>[' ','?'].includes(l[0]!))&&lines.includes(' M user/policy.txt')&&lines.includes('?? user/notes.txt'),{head:g.head,status:g.status})}
 check('DOCS',!!candidate['readme.md']?.data&&(manifest.repair||candidate['readme.md'].data!==seed['readme.md']?.data),'另行核对文档语义和示例');
 const normalized=clean(candidate);for(const p of protectedPaths)normalized[p]=seed[p]!;
 // tsimp生成进程私有缓存和Unix socket。只在离线重建时排除这一路径，原封存及保护检查不变。
 const runtimeCachePaths=task!=='V1-D'?Object.keys(normalized).filter(p=>p==='.tsimp'||p.startsWith('.tsimp/')):[];
 for(const p of runtimeCachePaths)delete normalized[p];logs.runtimeCacheOmitted=runtimeCachePaths;
 for(const p of runtimeCachePaths)if(seed[p])throw new GradingIndeterminate('cache_overlaps_seed',p);
 const extraPaths=Object.keys(normalized).filter(p=>!seed[p]&&!p.startsWith('eval-tests/'));check('SCOPE',extraPaths.length===0,extraPaths);
 const regressionFiles=Object.fromEntries(Object.entries(normalized).filter(([p,e])=>p.startsWith('eval-tests/')&&!seed[p]&&e.type==='file'));
 const newTests=Object.keys(regressionFiles).filter(p=>p.endsWith('.test.mjs')).sort();let testReplay:any;
 const timer=setTimeout(()=>{expired=true;void docker(['kill',...names.flatMap(n=>[n,n+'-init-own',n+'-init-restore'])],undefined,true,Math.max(1,deadline-Date.now()))},Math.max(1,window.workDeadline-Date.now()));
 timer.unref();
 try{
  const current=await isolated(IMAGE,task,names[0]!,normalized,window);logs.currentInitialization=current.initLog;
  const run=async(args:string[],input?:string)=>{const stage=args.slice(0,3).join(' '),allocated=remaining(stage),r=await execute(current,args,input,true,allocated);(logs.commands??=[] as any[]);(logs.commands as any[]).push({stage,args,allocatedMs:allocated,deadline,result:r});classifyCommand(r,stage);return r};
  for(const [label,line]of manifest.commands){if(options.upstream===false&&label!=='构建')continue;const r=await run(['bash','-lc',line],undefined);logs[label]=r;check(label,label==='原运行测试'?passedTests(testReport(r,label),manifest.upstreamTestCount):r.exitCode===0,r)}
  const measured=executableOracle(task,fixture(`oracle/${task==='V1-D'?'D':'E'}-test.mjs`));logs.oracleMeasurement=measured.measurement;mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(join(directory,'effective-oracle.test.mjs'),measured.source,{mode:0o600});
  const oracle={'eval-oracle/contract.test.mjs':file(measured.source),'eval-oracle/types.mts':file(fixture(`oracle/${task==='V1-D'?'D':'E'}-types.mts`))};
  const patch=await run(['bun','/opt/eval/c6-files.ts','patch'],JSON.stringify(oracle));if(patch.exitCode)throw new GradingIndeterminate('oracle_patch','patch',patch);
  const contract=testReport(await run(['node','--test','--test-reporter=tap','eval-oracle/contract.test.mjs'],undefined),'contract');logs.contract=contract;check('CONTRACT',passedTests(contract,22),contract);
  if(task!=='V1-D'){
   const cases=readFileSync(join(ROOT,'evals/specs/v1-attribution-followup-v1/reentrancy-cases.json'),'utf8'),matrix=fixture('oracle/E-reentry.mjs');
   writeFileSync(join(directory,'effective-reentry.test.mjs'),matrix,{mode:0o600});writeFileSync(join(directory,'reentrancy-cases.json'),cases,{mode:0o600});
   const installed=await run(['bun','/opt/eval/c6-files.ts','patch'],JSON.stringify({'eval-oracle/reentry.test.mjs':file(matrix),'eval-oracle/reentrancy-cases.json':file(cases)}));if(installed.exitCode)throw new GradingIndeterminate('matrix_patch','reentry',installed);
   const report=testReport(await run(['node','--test','--test-reporter=tap','eval-oracle/reentry.test.mjs']),'reentry');logs.reentry=report;check('REENTRY',passedTests(report,JSON.parse(cases).cases.length),report);
  }
  if(task!=='V1-D'){
   const source=fixture('oracle/E-waiting.mjs');writeFileSync(join(directory,'effective-waiting.test.mjs'),source,{mode:0o600});
   const installed=await run(['bun','/opt/eval/c6-files.ts','patch'],JSON.stringify({'eval-oracle/waiting.test.mjs':file(source)}));if(installed.exitCode)throw new GradingIndeterminate('waiting_patch','waiting',installed);
   const report=testReport(await run(['node','--test','--test-reporter=tap','eval-oracle/waiting.test.mjs']),'waiting-semantics');logs.waiting=report;check('WAITING_SEMANTICS',passedTests(report,19),report);
  }
  if(task!=='V1-D'){
   const source=fixture('oracle/E-waiter.mjs');writeFileSync(join(directory,'effective-waiter.test.mjs'),source,{mode:0o600});
   const installed=await run(['bun','/opt/eval/c6-files.ts','patch'],JSON.stringify({'eval-oracle/waiter.test.mjs':file(source)}));if(installed.exitCode)throw new GradingIndeterminate('waiter_patch','waiter',installed);
   const report=testReport(await run(['node','--test','--test-reporter=tap','eval-oracle/waiter.test.mjs']),'waiter');logs.waiter=report;check('WAITER',passedTests(report,1),report);
  }
  const types=await run(['node','/opt/toolchain/node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ESNext','--lib','ESNext,DOM','--module','NodeNext','--moduleResolution','NodeNext','eval-oracle/types.mts']);logs.types=types;check('TYPES',types.exitCode===0,types);
  if(task==='V1-U'||task==='V1-Q'){
   const source=fixture('assistance.mjs').replace('../../dist/index.js','../dist/index.js');
   const installed=await run(['bun','/opt/eval/c6-files.ts','patch'],JSON.stringify({'eval-oracle/target.test.mjs':file(source)}));if(installed.exitCode)throw new GradingIndeterminate('target_patch','Q_REPRO',installed);
   const report=testReport(await run(['node','--test','--test-reporter=tap','eval-oracle/target.test.mjs']),'Q_REPRO');logs.target=report;check('Q_REPRO',passedTests(report,1),report);
  }
  for(const b of changedJS(contents(seed['readme.md']!),candidate['readme.md']?contents(candidate['readme.md']):'')){const r=await run(['node','--input-type=module','--check'],b.source);check('README_JS:'+b.line,r.exitCode===0,r)}
  if(options.regression!==false&&newTests.length){
   const reporter=readFileSync(join(ROOT,'scripts/eval/attribution-followup/assertion-reporter.mjs'),'utf8'),reporterFiles={'eval-oracle/assertion-reporter.mjs':file(reporter)};
   writeFileSync(join(directory,'effective-assertion-reporter.mjs'),reporter,{mode:0o600});
   const installed=await run(['bun','/opt/eval/c6-files.ts','patch'],JSON.stringify(reporterFiles));if(installed.exitCode)throw new GradingIndeterminate('assertion_reporter_patch','regression',installed);
   const reporterFlag='--test-reporter=/task/eval-oracle/assertion-reporter.mjs';
   const now=testReport(await run(['node','--test',reporterFlag,...newTests],undefined),'regression-current','native-events');logs.regressionCurrent=now;
   const old=await isolated(IMAGE,task,names[1]!,{...clean(seed),...regressionFiles,...reporterFiles},window);logs.baselineInitialization=old.initLog;
   try{
    if(task!=='V1-D'){const built=await execute(old,['bash','-lc','npm run build'],undefined,true,remaining('baseline-build'));classifyCommand(built,'regression-old-build');logs.regressionPreviousBuild=built;if(built.exitCode!==0)throw new GradingIndeterminate('baseline_build','regression-old-build',built)}
    const previous=testReport(await execute(old,['node','--test',reporterFlag,...newTests],undefined,true,remaining('regression-old')),'regression-old','native-events');logs.regressionPrevious=previous;
    testReplay={paths:newTests,helperFiles:Object.keys(regressionFiles),current:now,previous,valid:passedTests(now)&&previous.exitCode!==0&&previous.total===now.total&&previous.failed>0&&previous.skipped===0&&previous.cancelled===0&&previous.assertionFailure,semanticReview:'pending'};
   }finally{/* 两个工作副本统一在同一截止前清理。 */}
  }else testReplay={valid:false,paths:newTests,reason:options.regression===false?'本次不评新增回归':'缺少独立新增回归'};
  const targetBehaviorPassed=task==='V1-U'||task==='V1-Q'?checks.find(c=>c.id==='Q_REPRO')?.pass===true&&['S119','S120','S125','S126'].every(id=>new RegExp('^ok \\d+ - '+id+' ','m').test((logs.reentry as any)?.stdout??'')):undefined;
  remaining('grade-complete');const result={task,checks,codePassed:checks.every(c=>c.pass),regressionPassed:testReplay.valid,targetBehaviorPassed,fullDeliveryPassed:null,reportReview:'pending',testReplay,logs,elapsedMs:Date.now()-start,complete:true};save(join(directory,'grade.json'),result);return result;
 }catch(error){save(join(directory,'grade-error.json'),{error:String(error),origin:error instanceof GradingIndeterminate?error.origin:'unknown_grader_error',stage:error instanceof GradingIndeterminate?error.stage:undefined,evidence:error instanceof GradingIndeterminate?error.evidence:undefined,checks,logs,expired});throw error}
 finally{
  clearTimeout(timer);
  const records=await cleanup(names,window);save(join(directory,'cleanup.json'),{deadline,finished:Date.now(),records});
 }
}

export async function grade(...args:Parameters<typeof gradeOwned>){return withResources('grade:'+args[1],()=>gradeOwned(...args))}
