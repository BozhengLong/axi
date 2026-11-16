import {mkdirSync,writeFileSync}from'node:fs';
import {join,resolve}from'node:path';
import assert from'node:assert/strict';
const [studyArg]=process.argv.slice(2);if(!studyArg)throw Error('需要研究目录');
const out=join(resolve(studyArg),'node-reporter-qualification');mkdirSync(out);
const cases=[
 {id:'scalar',body:"test('scalar',()=>assert.equal(1,2));",assertion:true,code:1},
 {id:'promise',body:"test('promise',()=>assert.equal(Promise.resolve(1),Promise.resolve(1)));",assertion:true,code:1},
 {id:'function',body:"test('function',()=>assert.equal(()=>1,()=>1));",assertion:true,code:1},
 {id:'async',body:"test('async',async()=>{await Promise.resolve();assert.equal(1,2)});",assertion:true,code:1},
 {id:'ordinary',body:"test('ordinary',()=>{throw Error('Expected actual to equal expected')});",assertion:false,code:1},
 {id:'misleading',body:"test('misleading',()=>{throw Error('AssertionError [ERR_ASSERTION]: example')});",assertion:false,code:1},
 {id:'import',body:"import './missing.mjs';",assertion:false,code:1},
 {id:'syntax',body:'const x = ;',assertion:false,code:1},
 {id:'pass',body:"test('pass',()=>assert.equal(1,1));",assertion:false,code:0},
 {id:'skip',body:"test.skip('skip',()=>assert.equal(1,2));",assertion:false,code:0},
 {id:'todo',body:"test.todo('todo');",assertion:false,code:0},
 {id:'cancelled',body:"test('cancelled',async()=>new Promise(()=>{}));",assertion:false,code:1},
 {id:'timeout',body:"test('timeout',{timeout:20},async()=>new Promise(r=>setTimeout(r,100)));",assertion:false,code:1},
];
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');save(join(out,'plan.json'),{node:'22.23.5',repeats:5,cases});
const rows:any[]=[];
for(const c of cases)for(let repeat=1;repeat<=5;repeat++){
 const id=`${c.id}-${repeat}`,dir=join(out,id);mkdirSync(dir);writeFileSync(join(dir,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';\n"+c.body+'\n');
 const args=['docker','run','--rm','--name','axi-r2-node-reporter-'+id,'--network','none','--user','1000:1000','--read-only','--tmpfs','/tmp:rw,size=64m','-v',`${dir}:/fixture:ro`,'-v',`${join(import.meta.dir,'reporters')}:/reporters:ro`,'--entrypoint','node','sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','--test','--test-reporter=/reporters/node.mjs','/fixture/case.test.mjs'];save(join(dir,'command.json'),args);
 const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill('SIGKILL')},10000);const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);clearTimeout(timer);writeFileSync(join(dir,'stdout'),stdout);writeFileSync(join(dir,'stderr'),stderr);
 if(timedOut)await Bun.spawn(['docker','rm','-f','axi-r2-node-reporter-'+id],{stdout:'ignore',stderr:'ignore'}).exited;assert(!timedOut);assert.equal(code,c.code);
 const marker='# AXI_TEST_ASSERTIONS_V1 ',lines=stdout.split('\n').filter(l=>l.startsWith(marker));assert.equal(lines.length,1);const native=JSON.parse(lines[0]!.slice(marker.length));assert.equal(native.failures.some((f:any)=>f.assertion),c.assertion);assert(native.cases.length>0);
 if(c.id==='skip')assert(native.cases.some((x:any)=>x.skip));if(c.id==='todo')assert(native.cases.some((x:any)=>x.todo));if(c.id==='cancelled')assert(native.failures.some((x:any)=>x.failureType==='cancelledByParent'));if(c.id==='timeout')assert(native.failures.some((x:any)=>x.failureType==='testTimeoutFailure'));
 const row={id,repeat,passed:true,code,assertion:c.assertion};rows.push(row);save(join(out,'results.json'),{qualified:rows.length===65,rows});console.log(JSON.stringify(row));
}
