// 参考示例独立资格：只替换本地包导入；fetch示例使用显式本地桩，不声称验证公网。
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {save,execute} from '../core.ts';
import {STUDY,IMAGE,authorization} from './config.ts';
import {reference} from './tasks.ts';
import {nativeOnceReference,lazyTimerReference} from './calibration-material.ts';
import {taskFiles,contents,file} from '../v1/tasks.ts';
import {changedJS} from '../rc/quality.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {withResources} from './resources.ts';
import {capture,unchanged} from './provenance.ts';
import {classifyCommand} from './status.ts';
const a=authorization(),directory=join(STUDY,'reference-examples-'+Date.now()),p=capture(directory),rows=[],declared=[];
const script=readFileSync(fileURLToPath(import.meta.url),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
save(join(directory,'runner.json'),{source:script,sha256:hash(script)});
for(let repeat=1;repeat<=5;repeat++)for(const task of ['V1-E','V1-D'])for(const variant of task==='V1-E'?['primary','alternative']:['primary','alternative','native-once','lazy-timer'])declared.push({repeat,task,variant});
save(join(directory,'declared.json'),{materials:30,exampleExecutions:35,declared,network:'disabled; fetch uses an explicit local stub'});let complete=false;
try{
 for(const c of declared){
  unchanged(p);await withResources('reference-examples',async()=>{
   const window=new GradeWindow(Math.min(Date.now()+60000,a.workDeadline)),name='axi-reentry-examples-'+Date.now(),candidate=c.variant==='native-once'?nativeOnceReference():c.variant==='lazy-timer'?lazyTimerReference():reference(c.task,c.variant);
   const examples=changedJS(contents(taskFiles(c.task)['readme.md']),contents(candidate['readme.md']));
   try{
    const runtime=await isolated(IMAGE,c.task,name,candidate,window);
    if(c.task==='V1-E'){const build=await execute(runtime,['bash','-lc','npm run build'],undefined,true,window.remaining('build'));save(join(directory,name+'-build.json'),build);classifyCommand(build,'build');if(build.exitCode)throw Error('示例构建失败')}
    for(let index=0;index<examples.length;index++){
     const original=examples[index].source,local=c.task==='V1-E'?'./dist/index.js':'./index.js';let source=original.replaceAll("'p-memoize'",JSON.stringify(local)).replaceAll("'p-retry'",JSON.stringify(local)),expected;
     const imports="import assert from 'node:assert/strict';\n";
     if(c.task==='V1-E'&&c.variant==='primary'){source=imports+source+"assert.equal(calls,2);\n";expected='a:1\na:1\na:2\n'}
     else if(c.task==='V1-E'){source=imports+source+"assert.equal(count,3);assert.deepEqual(await getUser('alice'),{id:'alice',version:3});assert.deepEqual(await getUser('bob'),{id:'bob',version:2});\n";expected=''}
     else if(source.includes('fetch(')){
      source=imports+"let fetchCalls=0;globalThis.fetch=async(url,{signal})=>{assert.equal(url,'https://sindresorhus.com/unicorn');assert.ok(signal instanceof AbortSignal);assert.equal(signal.aborted,false);fetchCalls++;return new Response('local-example')};\n"+source+"assert.equal(fetchCalls,1);assert.equal(await response.text(),'local-example');\n";expected='';
     }else if(source.includes('new AttemptTimeoutError(2, 5000)'))expected='2 5000\n';
     else expected='1 false\n2 false\ntrue\n';
     const result=await execute(runtime,['node','--input-type=module','-e',source],undefined,true,window.remaining('example'));classifyCommand(result,'example');const passed=result.exitCode===0&&result.stdout===expected;
     const row={...c,index,line:examples[index].line,sourceSha256:hash(original),executableSha256:hash(source),source:original,executable:source,expected,result,passed};rows.push(row);save(join(directory,'rows.json'),rows);if(!passed)throw Error('参考示例结果不符');
    }
   }finally{save(join(directory,name+'-cleanup.json'),await cleanup([name],window))}
  });
 }
 unchanged(p);complete=rows.length===35&&rows.every(r=>r.passed);
}finally{save(join(STUDY,'reference-examples-latest.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,runnerSha256:hash(script),directory,rows})}
if(!complete)throw Error('预声明示例未全部完成');
console.log(JSON.stringify({complete,examples:rows.length,directory}));
