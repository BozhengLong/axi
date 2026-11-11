import {join} from 'node:path';
import {assertVerificationCompleted} from './verification-status.ts';
import {execute,docker,save,type Snapshot} from '../core.ts';
import {helper} from '../c6/runtime.ts';
import {grade as c7Grade,type GitState} from '../c7/grade.ts';
import {isolated} from './runtime.ts';
import {clean,file,fixture,taskManifest} from './tasks.ts';
import {GRADE_MS,type TaskId} from './settings.ts';
import {TYPECHECK_NODE} from './node-verifier.ts';
export function parseTests(r:{exitCode:number;stdout:string;stderr:string}){
 const n=(k:string)=>Number(r.stdout.match(new RegExp('^# '+k+' (\\d+)','m'))?.[1]??-1);
 return {...r,total:n('tests'),passed:n('pass'),failed:n('fail'),skipped:n('skipped'),cancelled:n('cancelled'),assertionFailure:/ERR_ASSERTION|AssertionError/.test(r.stdout+r.stderr)};
}
const nodeTests=async(name:string,paths:string[])=>parseTests(await execute({name},['node','--test','--test-timeout=30000','--test-reporter=tap',...paths],undefined,true,60000));
const completeTests=(r:ReturnType<typeof parseTests>,count?:number)=>r.exitCode===0&&r.total>0&&r.passed===r.total&&r.skipped===0&&r.cancelled===0&&(count===undefined||r.total===count);
export async function grade(image:string,task:TaskId,id:string,seed:Snapshot,candidate:Snapshot,directory:string,options:{executionStatus?:string;git?:GitState;initialGit?:GitState;regression?:boolean;deadline?:number}={}){
 if(task==='C7-L'||task==='C7-O')return c7Grade(image,task,id,seed,candidate,directory,options);
 const start=Date.now(),checks:{id:string;pass:boolean;actual:unknown}[]=[],logs:Record<string,any>={};
 let expired=false;
 const limit=Math.min(GRADE_MS,(options.deadline??Infinity)-start);
 const names=[`axi-v1-${id}-current`,`axi-v1-${id}-old`];
 const timer=setTimeout(()=>{expired=true;void docker(['kill',...names],undefined,true)},Math.max(1,limit));
 const check=(id:string,pass:boolean,actual:unknown)=>checks.push({id,pass,actual});
 const deadline=()=>{if(expired||Date.now()-start>limit)throw Error('grade_deadline')};
 const protectedPaths:string[]=taskManifest(task).protected;
 const changed=protectedPaths.filter(p=>JSON.stringify(seed[p])!==JSON.stringify(candidate[p]));
 check('DELIVERY',(options.executionStatus??'completed')==='completed',options.executionStatus??'completed');
 check('PROTECT',changed.length===0,changed);
 if(options.git&&options.initialGit){const g=options.git,lines=g.status.trimEnd().split('\n').filter(Boolean);check('GIT',g.valid&&g.head===options.initialGit.head&&lines.every(l=>[' ','?'].includes(l[0]!))&&lines.includes(' M user/policy.txt')&&lines.includes('?? user/notes.txt'),{head:g.head,status:g.status});}
 check('DOCS',candidate['readme.md']?.data!==seed['readme.md']?.data&&!!candidate['readme.md']?.data,'文档须另行人工语义复查');
 const normalized=clean(candidate);for(const p of protectedPaths)normalized[p]=seed[p]!;
 const regressionFiles=Object.fromEntries(Object.entries(normalized).filter(([p,e])=>p.startsWith('eval-tests/')&&!seed[p]&&e.type==='file'));
 const newTests=Object.keys(regressionFiles).filter(p=>p.endsWith('.test.mjs')).sort();
 let testReplay:any;
 const current=await isolated(image,task,`${id}-current`,normalized);
 try{
  for(const [key,args] of [
   ['upstream',['node','node_modules/ava/entrypoints/cli.mjs','--config','eval/ava.config.mjs',task==='V1-A'?'test.js':'test/index.js']],
   ['upstreamTypes',['node','node_modules/tsd/dist/cli.js']],
  ] as const){deadline();const r=await execute(current,[...args],undefined,true,120000);logs[key]=r;assertVerificationCompleted(r,key);check(key,r.exitCode===0,r);}
  const hidden={'eval-oracle/contract.test.mjs':file(fixture(`oracle/${task.slice(-1)}-test.mjs`)),'eval-oracle/types.mts':file(fixture(`oracle/${task.slice(-1)}-types.mts`))};
  const patch=await helper(image,current.volume,['bun','/opt/eval/c6-files.ts','patch'],true,JSON.stringify(hidden));if(patch.exitCode)throw Error(patch.stderr);
  deadline();const contract=await nodeTests(current.name,['eval-oracle/contract.test.mjs']);logs.contract=contract;assertVerificationCompleted(contract,'contract');check('CONTRACT',completeTests(contract,task==='V1-A'?7:8),contract);
  const types=await execute(current,[...TYPECHECK_NODE,'/opt/toolchain/node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ESNext','--module','NodeNext','--moduleResolution','NodeNext','eval-oracle/types.mts'],undefined,true,60000);logs.types=types;assertVerificationCompleted(types,'types');check('TYPES',types.exitCode===0,types);
  deadline();
  if(options.regression!==false&&newTests.length){
   const now=await nodeTests(current.name,newTests);logs.regressionCurrent=now;assertVerificationCompleted(now,'regression-current');const old=await isolated(image,task,`${id}-old`,{...clean(seed),...regressionFiles});
   try{const previous=await nodeTests(old.name,newTests);logs.regressionPrevious=previous;assertVerificationCompleted(previous,'regression-old');testReplay={paths:newTests,helperFiles:Object.keys(regressionFiles),current:now,previous,valid:completeTests(now)&&previous.exitCode!==0&&previous.total===now.total&&previous.failed>0&&previous.skipped===0&&previous.cancelled===0&&previous.assertionFailure,semanticReview:'pending'};}
   finally{await old.close();}
  }else testReplay={valid:false,reason:options.regression===false?'本次未运行回归复验':'没有新增独立回归',paths:newTests};
  deadline();const result={task,checks,codePassed:checks.every(c=>c.pass),regressionPassed:testReplay.valid,fullDeliveryPassed:null,reportReview:'pending',testReplay,logs,elapsedMs:Date.now()-start,complete:true};save(join(directory,'grade.json'),result);return result;
 }catch(error){save(join(directory,'grade-error.json'),{error:String(error),checks,logs,expired});throw error;}
 finally{clearTimeout(timer);await current.close();}
}
