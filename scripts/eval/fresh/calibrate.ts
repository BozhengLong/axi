import {join} from 'node:path';
import {save,type Snapshot} from '../core.ts';
import {file,contents,taskFiles} from '../v1/tasks.ts';
import {grade} from './grade.ts';
import {reference} from './tasks.ts';
import {FRESH,IMAGE,tasks,preparationGate,type FreshTask} from './settings.ts';
import {fingerprint} from '../complex/fingerprint.ts';
const authorization=preparationGate(),stamp=Date.now(),directory=join(FRESH,'calibration-'+stamp),rows:any[]=[];
type Case={task:FreshTask;name:string;candidate:Snapshot;code:boolean;regression?:boolean;upstream?:boolean};
const cases:Case[]=[];
for(const task of tasks){cases.push({task,name:'reference',candidate:reference(task),code:true,regression:true,upstream:true},{task,name:'baseline',candidate:taskFiles(task),code:false,upstream:true});
 const taut=reference(task);taut['eval-tests/reference.test.mjs']=file("import test from 'node:test'; import assert from 'node:assert/strict'; test('always',()=>assert.equal(1,1));\n");cases.push({task,name:'tautology',candidate:taut,code:true,regression:false});
}
function mutant(task:FreshTask,name:string,before:string,after:string){const path=task==='V1-E'?'index.ts':'index.js',candidate=reference(task),text=contents(candidate[path]!);if(text.split(before).length!==2)throw Error('变异位置不唯一:'+name);candidate[path]=file(text.replace(before,after));cases.push({task,name,candidate,code:false})}
mutant('V1-E','missing-invalidation','state.version++;','void state.version;');
mutant('V1-E','keep-old-flight','store.promiseCache.delete(key);','void key;');
mutant('V1-E','ignore-barrier','while (keyState?.deletion) {','while (keyState?.deletion && Date.now() < 0) {');
mutant('V1-E','skip-started-writes','await Promise.allSettled([...state.writes]);','void state.writes;');
mutant('V1-E','old-cleanup-erases-new','if (promiseCache.get(key) === promise) {','if (true) {');
mutant('V1-E','delete-not-serialized','if (previous) await previous.catch(() => undefined);','void previous;');
mutant('V1-E','invalidate-unrelated-keys','state.version++;','state.version++; shared.generation++;');
mutant('V1-D','timeout-skips-policy','if (await onAttemptFailure({', 'if (error instanceof AttemptTimeoutError) throw error;\n\t\t\tif (await onAttemptFailure({');
mutant('V1-D','shared-controller','function runTimedAttempt(input, attemptNumber, options) {\n\tconst controller = new AbortController();','let sharedController;\nfunction runTimedAttempt(input, attemptNumber, options) {\n\tconst controller = sharedController ??= new AbortController();');
mutant('V1-D','ignore-live-abort',"options.signal?.addEventListener('abort', onAbort, {once: true});\n\t\tif (Number.isFinite", "// missing external listener\n\t\tif (Number.isFinite");
mutant('V1-D','late-rejection-escapes','error => { finish(false, error); },','error => { if (settled) throw error; finish(false, error); },');
mutant('V1-D','timer-leak','clearTimeout(timer);','void timer;');
mutant('V1-D','listener-leak',"options.signal?.removeEventListener('abort', onAbort);\n\t\t\t(success", "// missing cleanup\n\t\t\t(success");
mutant('V1-D','wrapper-injects-context','pRetry(() => function_.apply(this, arguments_), options)','pRetry((n, ctx) => function_.apply(this, [...arguments_, ctx]), options)');
mutant('V1-D','missing-attempt-unref','timer.unref?.();','void timer;');
let complete=true;
try{for(const c of cases){
 const r=await grade(c.task,`fresh-cal-${stamp}-${rows.length}`,taskFiles(c.task),c.candidate,join(directory,c.task+'-'+c.name),{regression:c.regression!==undefined,upstream:c.upstream===true,deadline:authorization.workDeadline});
 const contract=r.checks.find(x=>x.id==='CONTRACT'),upstream=r.checks.filter(x=>['构建','原运行测试','原类型测试'].includes(x.id));
 const passed=r.codePassed===c.code&&(c.code||contract?.pass===false)&&(c.regression===undefined||r.regressionPassed===c.regression)&&(!c.upstream||(upstream.length===(c.task==='V1-E'?3:2)&&upstream.every(x=>x.pass)));rows.push({task:c.task,case:c.name,passed,expected:{code:c.code,regression:c.regression},actual:{code:r.codePassed,regression:r.regressionPassed},failedChecks:r.checks.filter(x=>!x.pass).map(x=>x.id)});save(join(directory,'results.json'),rows);console.log(JSON.stringify(rows.at(-1)));if(!passed){complete=false;break}
}}catch(error){complete=false;save(join(directory,'error.json'),{error:String(error)});throw error}
finally{save(join(FRESH,'calibration-latest.json'),{complete,image:IMAGE,sourceHash:fingerprint().sourceHash,directory,rows})}
if(!complete)throw Error('校准未通过');
