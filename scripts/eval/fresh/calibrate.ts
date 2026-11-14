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
function mutant(task:FreshTask,name:string,before:string,after:string){const candidate=reference(task),text=contents(candidate['index.js']!);if(text.split(before).length!==2)throw Error('变异位置不唯一:'+name);candidate['index.js']=file(text.replace(before,after));cases.push({task,name,candidate,code:false})}
mutant('V1-C','default-after',"options.evictionTiming === undefined ? 'before'", "options.evictionTiming === undefined ? 'after'");
mutant('V1-C','ignore-after',"this.#evictionTiming = timing;", "this.#evictionTiming = 'before';");
mutant('V1-C','swallow-errors','if (failed) {\n\t\t\tthrow firstError;', 'if (false && failed) {\n\t\t\tthrow firstError;');
mutant('V1-C','stop-notifications','} catch (error) {\n\t\t\t\tif (!failed)', '} catch (error) {\n\t\t\t\tthrow error;\n\t\t\t\tif (!failed)');
mutant('V1-C','resurrect-shadow','return this.#oldCache.delete(key) || deleted;', 'return deleted || this.#oldCache.delete(key);');
mutant('V1-C','overwrite-nested-resize','this.#emitEvictions([...expired, ...live.slice(0, Math.max(0, removeCount))]);\n\t\t\treturn;', 'this.#emitEvictions([...expired, ...live.slice(0, Math.max(0, removeCount))]);\n\t\t\tthis.#maxSize = newSize;\n\t\t\treturn;');
mutant('V1-C','remove-stale-guard',"this.#evictionTiming === 'after' && (this.#cache.get(key) ?? this.#oldCache.get(key)) !== item", "false && this.#evictionTiming === 'after' && (this.#cache.get(key) ?? this.#oldCache.get(key)) !== item");
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
 const contract=r.checks.find(x=>x.id==='CONTRACT'),upstream=r.checks.filter(x=>['原运行测试','原类型测试'].includes(x.id));
 const passed=r.codePassed===c.code&&(c.code||contract?.pass===false)&&(c.regression===undefined||r.regressionPassed===c.regression)&&(!c.upstream||(upstream.length===2&&upstream.every(x=>x.pass)));rows.push({task:c.task,case:c.name,passed,expected:{code:c.code,regression:c.regression},actual:{code:r.codePassed,regression:r.regressionPassed},failedChecks:r.checks.filter(x=>!x.pass).map(x=>x.id)});save(join(directory,'results.json'),rows);console.log(JSON.stringify(rows.at(-1)));if(!passed){complete=false;break}
}}catch(error){complete=false;save(join(directory,'error.json'),{error:String(error)});throw error}
finally{save(join(FRESH,'calibration-latest.json'),{complete,image:IMAGE,sourceHash:fingerprint().sourceHash,directory,rows})}
if(!complete)throw Error('校准未通过');
