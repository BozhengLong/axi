import {join} from 'node:path';
import {save,type Snapshot} from '../core.ts';
import {taskFiles,contents,file} from '../v1/tasks.ts';
import {capture,unchanged} from './provenance.ts';
import {reference} from './tasks.ts';
import {grade} from './grade.ts';
import {STUDY,tasks,authorization,type DevTask} from './config.ts';
const a=authorization(),stamp=Date.now(),directory=join(STUDY,'calibration-'+stamp),rows:any[]=[];const provenance=capture(directory);
type Case={task:DevTask;name:string;candidate:Snapshot;code:boolean;regression?:boolean;upstream?:boolean;target?:string};
const cases:Case[]=[];
for(const task of tasks){
 for(const variant of ['primary','alternative']as const)cases.push({task,name:variant,candidate:reference(task,variant),code:true,regression:true,upstream:true});
 cases.push({task,name:'baseline',candidate:taskFiles(task),code:false,upstream:true});
 const taut=reference(task);taut['eval-tests/reference.test.mjs']=file("import test from 'node:test';import assert from 'node:assert/strict';test('always',()=>assert.equal(1,1));\n");cases.push({task,name:'tautology',candidate:taut,code:true,regression:false});
}
function mutant(task:DevTask,name:string,before:string,after:string,target?:string){const candidate=reference(task),path=task==='V1-E'?'index.ts':'index.js',s=contents(candidate[path]!);if(s.split(before).length!==2)throw Error('变异位置不唯一:'+name);candidate[path]=file(s.replace(before,after));cases.push({task,name,candidate,code:false,target})}
mutant('V1-E','key-receiver',"cacheKey: arguments_ => cacheKey(arguments_ as Parameters<FunctionToMemoize>),","cacheKey: arguments_ => cacheKey.call({}, arguments_ as Parameters<FunctionToMemoize>),",'E21');
mutant('V1-E','extra-assimilation','await operation();','await Promise.resolve().then(operation);','E22');
mutant('V1-E','skip-writes','await Promise.allSettled([...state.writes]);','void state.writes;','E13');
mutant('V1-E','missing-invalidation','state.version++;','void state.version;','E04');
mutant('V1-E','keep-old-flight','store.promiseCache.delete(key);','void key;','E04');
mutant('V1-D','extra-assimilation','const value = await input(attemptNumber, context);','const value = await Promise.resolve().then(() => input(attemptNumber, context));','D20');
mutant('V1-D','inspect-cancel-reason','if (timed) options.signal?.throwIfAborted();','void timed;','D08');
mutant('V1-D','late-rejection-escapes','catch (error) { finish(false, error); }','catch (error) { throw error; }');
mutant('V1-D','listener-leak',"options.signal?.removeEventListener('abort', onAbort);\n\t\t\tresolve({success, value});", "// 故意漏清理\n\t\t\tresolve({success, value});",'D13');
mutant('V1-D','timer-leak','clearTimeout(timer);','void timer;','D13');
mutant('V1-D','wrapper-injects-context','pRetry(() => function_.apply(this, arguments_), options)','pRetry((n, ctx) => function_.apply(this, [...arguments_, ctx]), options)','D16');
save(join(directory,'declared-cases.json'),cases.map(({candidate,...x})=>x));let complete=false;
try{
 for(const c of cases){
  unchanged(provenance);
  const r=await grade(c.task,`trust-cal-${stamp}-${rows.length}`,taskFiles(c.task),c.candidate,join(directory,c.task+'-'+c.name),{upstream:c.upstream===true,regression:c.regression!==undefined,deadline:a.workDeadline});
  const contract=r.checks.find(x=>x.id==='CONTRACT'),upstream=r.checks.filter(x=>['构建','原运行测试','原类型测试'].includes(x.id));
  const targetFailure=!c.target||new RegExp('not ok \\d+ - '+c.target+' ').test((r.logs.contract as any).stdout);
  const passed=r.codePassed===c.code&&(c.code||contract?.pass===false)&&targetFailure&&(c.regression===undefined||r.regressionPassed===c.regression)&&(!c.upstream||(upstream.length===(c.task==='V1-E'?3:2)&&upstream.every(x=>x.pass)));
  rows.push({task:c.task,name:c.name,passed,code:r.codePassed,regression:r.regressionPassed,target:c.target,targetFailure,failedChecks:r.checks.filter(x=>!x.pass).map(x=>x.id)});save(join(directory,'rows.json'),rows);console.log(JSON.stringify(rows.at(-1)));if(!passed)throw Error('校准与预期不符');
 }
 unchanged(provenance);complete=true;
}finally{save(join(STUDY,'calibration-latest.json'),{complete,declared:cases.length,sourceHash:provenance.sourceHash,directory,rows})}
