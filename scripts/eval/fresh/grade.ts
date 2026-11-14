import {join} from 'node:path';
import {save,execute,docker,type Snapshot} from '../core.ts';
import {helper} from '../c6/runtime.ts';
import {clean,file,contents,taskManifest} from '../v1/tasks.ts';
import {isolated} from '../v1/runtime.ts';
import {parseTests} from '../v1/grade.ts';
import {assertVerificationCompleted} from '../v1/verification-status.ts';
import {changedJS} from '../rc/quality.ts';
import {fixture} from './tasks.ts';
import {IMAGE,type FreshTask} from './settings.ts';
import type {GitState} from '../c7/grade.ts';
const complete=(r:ReturnType<typeof parseTests>,count?:number)=>r.exitCode===0&&r.total>0&&r.passed===r.total&&r.skipped===0&&r.cancelled===0&&(count===undefined||r.total===count);
export async function grade(task:FreshTask,id:string,seed:Snapshot,candidate:Snapshot,directory:string,options:{executionStatus?:string;git?:GitState;initialGit?:GitState;regression?:boolean;deadline?:number;upstream?:boolean}={}){
 const start=Date.now(),deadline=Math.min(start+15*60000,options.deadline??Infinity),checks:{id:string;pass:boolean;actual:unknown}[]=[],logs:Record<string,unknown>={};
 let expired=false;const names=[`axi-v1-${id}-current`,`axi-v1-${id}-old`];
 const timer=setTimeout(()=>{expired=true;void docker(['kill',...names],undefined,true)},Math.max(1,deadline-start));
 const check=(id:string,pass:boolean,actual:unknown)=>checks.push({id,pass,actual});
 const remaining=(max:number)=>{if(expired||Date.now()>=deadline)throw Error('fresh_grade_deadline');return Math.min(max,deadline-Date.now())};
 const manifest=taskManifest(task),protectedPaths:string[]=manifest.protected;
 check('DELIVERY',(options.executionStatus??'completed')==='completed',options.executionStatus??'completed');
 const changed=protectedPaths.filter(p=>JSON.stringify(seed[p])!==JSON.stringify(candidate[p]));check('PROTECT',changed.length===0,changed);
 if(options.git&&options.initialGit){const g=options.git,lines=g.status.trimEnd().split('\n').filter(Boolean);check('GIT',g.valid&&g.head===options.initialGit.head&&lines.every(l=>[' ','?'].includes(l[0]!))&&lines.includes(' M user/policy.txt')&&lines.includes('?? user/notes.txt'),{head:g.head,status:g.status})}
 check('DOCS',!!candidate['readme.md']?.data&&candidate['readme.md'].data!==seed['readme.md']?.data,'另行核对文档语义和示例');
 const normalized=clean(candidate);for(const p of protectedPaths)normalized[p]=seed[p]!;
 const regressionFiles=Object.fromEntries(Object.entries(normalized).filter(([p,e])=>p.startsWith('eval-tests/')&&!seed[p]&&e.type==='file'));
 const newTests=Object.keys(regressionFiles).filter(p=>p.endsWith('.test.mjs')).sort();let testReplay:any;
 const current=await isolated(IMAGE,task,`${id}-current`,normalized);
 try{
  const run=async(args:string[],input?:string,max=60000)=>{const r=await execute(current,args,input,true,remaining(max));assertVerificationCompleted(r,args.slice(0,3).join(' '));return r};
  if(options.upstream!==false)for(const [label,line]of manifest.commands){const r=await run(['bash','-lc',line],undefined,300000);logs[label]=r;check(label,r.exitCode===0,r)}
  const oracle={'eval-oracle/contract.test.mjs':file(fixture(`oracle/${task.slice(-1)}-test.mjs`)),'eval-oracle/types.mts':file(fixture(`oracle/${task.slice(-1)}-types.mts`))};
  const patch=await helper(IMAGE,current.volume,['bun','/opt/eval/c6-files.ts','patch'],true,JSON.stringify(oracle));if(patch.exitCode)throw Error(patch.stderr);
  const contract=parseTests(await run(['node','--test','--test-reporter=tap','--test-timeout=10000','eval-oracle/contract.test.mjs'],undefined,120000));logs.contract=contract;if(/^#? ?FRESH_ORACLE_INFRA:[A-Z0-9_]+$/m.test(contract.stdout+'\n'+contract.stderr))throw Error('场景子进程发生非预期设施/信号退出');check('CONTRACT',complete(contract,task==='V1-C'?17:19),contract);
  const types=await run(['node','/opt/toolchain/node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ESNext','--lib','ESNext,DOM','--module','NodeNext','--moduleResolution','NodeNext','eval-oracle/types.mts']);logs.types=types;check('TYPES',types.exitCode===0,types);
  for(const b of changedJS(contents(seed['readme.md']!),candidate['readme.md']?contents(candidate['readme.md']):'')){const r=await run(['node','--input-type=module','--check'],b.source);check('README_JS:'+b.line,r.exitCode===0,r)}
  if(options.regression!==false&&newTests.length){
   const now=parseTests(await run(['node','--test','--test-reporter=tap','--test-timeout=10000',...newTests],undefined,120000));logs.regressionCurrent=now;
   const old=await isolated(IMAGE,task,`${id}-old`,{...clean(seed),...regressionFiles});
   try{
    const previous=parseTests(await execute(old,['node','--test','--test-reporter=tap','--test-timeout=10000',...newTests],undefined,true,remaining(120000)));assertVerificationCompleted(previous,'fresh-regression-old');logs.regressionPrevious=previous;
    testReplay={paths:newTests,helperFiles:Object.keys(regressionFiles),current:now,previous,valid:complete(now)&&previous.exitCode!==0&&previous.total===now.total&&previous.failed>0&&previous.skipped===0&&previous.cancelled===0&&previous.assertionFailure,semanticReview:'pending'};
   }finally{await old.close()}
  }else testReplay={valid:false,paths:newTests,reason:options.regression===false?'本次不评新增回归':'缺少独立新增回归'};
  remaining(1);const result={task,checks,codePassed:checks.every(c=>c.pass),regressionPassed:testReplay.valid,fullDeliveryPassed:null,reportReview:'pending',testReplay,logs,elapsedMs:Date.now()-start,complete:true};save(join(directory,'grade.json'),result);return result;
 }catch(error){save(join(directory,'grade-error.json'),{error:String(error),checks,logs,expired});throw error}
 finally{clearTimeout(timer);await current.close()}
}
