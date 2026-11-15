import {join} from 'node:path';
import {save,execute} from '../core.ts';
import {taskFiles} from '../v1/tasks.ts';
import {reference} from './tasks.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {classifyCommand} from './status.ts';
import {withResources} from './resources.ts';
import {STUDY,IMAGE,tasks} from './config.ts';
import {capture,unchanged} from './provenance.ts';
const directory=join(STUDY,'compatibility-'+Date.now()),p=capture(directory),rows:any[]=[];let complete=false;
const probes={
 'V1-E':`import assert from 'node:assert/strict';import memo from './dist/index.js';
 const keys=[];const cached=memo(async x=>x,{cacheKey:function(args){assert.equal(this,undefined);keys.push(args);return args[0]}});assert.equal(await cached('x'),'x');assert.equal(await cached('x'),'x');assert.equal(keys.length,2);
 for(const kind of ['native','thenable']){const error=new Error(kind);let thenReads=0;const cache=new Map();cache.set=function(){assert.equal(this,cache);if(kind==='thenable')return {then(a,b){thenReads++;b(error)}};const p=Promise.reject(error);Object.defineProperty(p,'then',{get(){thenReads++;throw new Error('extra observation')}});return p};
 const fn=memo(async()=>1,{cache});let caught;try{await fn()}catch(e){caught=e}assert.equal(caught,error);assert.equal(thenReads,kind==='native'?0:1);await new Promise(r=>setImmediate(r))}console.log('compatible-original-behavior');`,
 'V1-D':`import assert from 'node:assert/strict';import retry from './index.js';
 for(const kind of ['native','thenable']){const error=new Error(kind);let thenReads=0;const input=function(){assert.equal(arguments.length,1);if(kind==='thenable')return {then(a,b){thenReads++;b(error)}};const p=Promise.reject(error);Object.defineProperty(p,'then',{get(){thenReads++;throw new Error('extra observation')}});return p};
 let caught;try{await retry(input,{retries:0})}catch(e){caught=e}assert.equal(caught,error);assert.equal(thenReads,kind==='native'?0:1);await new Promise(r=>setImmediate(r))}
 const reason=new Proxy({},{get(){throw new Error('reason must stay opaque')},getPrototypeOf(){throw new Error('reason must stay opaque')}});const c=new AbortController();c.abort(reason);let called=false,caught;try{await retry(()=>{called=true},{signal:c.signal})}catch(e){caught=e}assert.equal(caught,reason);assert.equal(called,false);console.log('compatible-original-behavior');`,
};
save(join(directory,'declared-probes.json'),probes);
try{for(const task of tasks)for(const variant of ['baseline','primary','alternative']as const){
 unchanged(p);await withResources('compatibility',async()=>{const window=new GradeWindow(Date.now()+60000),name='axi-trust-compatible-'+Date.now();try{
  const r=await isolated(IMAGE,task,name,variant==='baseline'?taskFiles(task):reference(task,variant),window),logs:any[]=[];
  if(task==='V1-E'){const build=await execute(r,['bash','-lc','npm run build'],undefined,true,window.remaining('build'));logs.push(build);classifyCommand(build,'build');if(build.exitCode)throw Error('原行为检查构建失败')}
  const result=await execute(r,['node','--input-type=module','-e',probes[task]],undefined,true,window.remaining('original-behavior'));classifyCommand(result,'original-behavior');const passed=result.exitCode===0&&result.stdout.trim()==='compatible-original-behavior';rows.push({task,variant,passed,logs,result});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({task,variant,passed}));if(!passed)throw Error('可信原态可观察行为不一致');
 }finally{save(join(directory,name+'-cleanup.json'),await cleanup([name],window))}})
}unchanged(p);complete=true}finally{save(join(STUDY,'compatibility-latest.json'),{complete,sourceHash:p.sourceHash,image:IMAGE,directory,rows})}
