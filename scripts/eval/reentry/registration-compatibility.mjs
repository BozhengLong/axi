import {join} from 'node:path';
import {save,execute} from '../core.ts';
import {taskFiles} from '../v1/tasks.ts';
import {reference} from './tasks.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {withResources} from './resources.ts';
import {STUDY,IMAGE} from './config.ts';
import {capture,unchanged} from './provenance.ts';
const probe=`import assert from 'node:assert/strict';import memo from './dist/index.js';
const observed=p=>p.then(value=>({value}),error=>({error}));
for(const mode of ['ordinary','outer-error','inner-error']){
 const cache=new Map(),nested=[],error={mode};let calls=0,entered=false,left=2;
 cache.has=function(k){
  if(mode==='ordinary'){if(left-->0)nested.push(f(k));return Map.prototype.has.call(this,k)}
  if(!entered){entered=true;nested.push(f(k));if(mode==='outer-error')throw error;return false}
  if(mode==='inner-error')throw error;return false;
 };
 const f=memo(async()=>++calls,{cache});const root=f('x'),rootResult=observed(root),nestedResults=nested.map(observed),next=f('x'),nextResult=observed(next);
 const identity=next===(mode==='outer-error'?nested[0]:root);const results=await Promise.all([rootResult,nextResult,...nestedResults]);
 console.log(JSON.stringify({mode,identity,calls,results}));assert.equal(identity,true,'preserve original in-flight promise identity');assert.equal(calls,1);
 if(mode==='outer-error')assert.equal(results[0].error,error);else assert.equal(results[0].value,1);
}
`;
const directory=join(STUDY,'registration-compatibility-'+Date.now()),p=capture(directory),rows=[];save(join(directory,'probe.json'),{source:probe});
for(const variant of ['baseline','primary','alternative']){
 unchanged(p);await withResources('registration-compatibility',async()=>{
 const window=new GradeWindow(Date.now()+60000),name='axi-reentry-registration-'+Date.now();
 try{const r=await isolated(IMAGE,'V1-E',name,variant==='baseline'?taskFiles('V1-E'):reference('V1-E',variant),window);
 const build=await execute(r,['bash','-lc','npm run build'],undefined,true,window.remaining('build'));if(build.exitCode)throw Error('构建失败');
 const result=await execute(r,['node','--input-type=module','-e',probe],undefined,true,window.remaining('probe'));rows.push({variant,passed:result.exitCode===0&&!result.timedOut,build,result});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({variant,passed:rows.at(-1).passed,observations:result.stdout.trim()}));
 }finally{save(join(directory,name+'-cleanup.json'),await cleanup([name],window))}
 });
}
const complete=rows.every(r=>r.passed);save(join(STUDY,'registration-compatibility-latest.json'),{complete,directory,sourceHash:p.sourceHash,rows});if(!complete)process.exitCode=1;
