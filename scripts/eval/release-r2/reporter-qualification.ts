import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const [studyArg]=process.argv.slice(2);if(!studyArg)throw Error('需要研究目录');
const study=resolve(studyArg),out=join(study,'vitest-reporter-qualification');mkdirSync(out);
const fixtures=[
 {id:'expect',body:"test('expect',()=>expect(1).toBe(2));",state:'fail',assertion:true},
 {id:'node-assert',body:"test('node',()=>assert.equal(1,2));",state:'fail',assertion:true},
 {id:'promise-identity',body:"test('promise',()=>expect(Promise.resolve(1)).toBe(Promise.resolve(1)));",state:'fail',assertion:true},
 {id:'ordinary',body:"test('ordinary',()=>{throw Error('AssertionError [ERR_ASSERTION]: fake words')});",state:'fail',assertion:false},
 {id:'pass',body:"test('pass',()=>expect(1).toBe(1));",state:'pass',assertion:false},
 {id:'skip',body:"test.skip('skip',()=>expect(1).toBe(2));",state:'skip',assertion:false},
 {id:'todo',body:"test.todo('todo');",state:'todo',assertion:false},
 {id:'import',body:"import './missing-module.js';",state:'load-error',assertion:false},
 {id:'syntax',body:'const invalid = ;',state:'load-error',assertion:false},
 {id:'timeout',body:"test('timeout',async()=>new Promise(()=>{}),20);",state:'fail',assertion:false},
];
const save=(path:string,v:unknown)=>writeFileSync(path,JSON.stringify(v,null,2)+'\n');
save(join(out,'plan.json'),{framework:'vitest'+JSON.parse(readFileSync(join(study,'task-selection/sources/cosmiconfig/node_modules/vitest/package.json'),'utf8')).version,repeats:5,fixtures,scope:'native assertion provenance and skip/load/timeout separation; no models'});
const rows:any[]=[];const reporter=join(import.meta.dir,'reporters'),deps=join(study,'task-selection/sources/cosmiconfig/node_modules');
for(const f of fixtures)for(let repeat=1;repeat<=5;repeat++){
 const id=`${f.id}-${repeat}`,dir=join(out,id),source=join(dir,'source');mkdirSync(source,{recursive:true});
 writeFileSync(join(source,'case.test.ts'),"import {test,expect} from 'vitest';import assert from 'node:assert/strict';\n"+f.body+'\n');
 writeFileSync(join(source,'vitest.config.mjs'),"export default {test:{threads:false,environment:'node',cache:false}};\n");
 const args=['docker','run','--rm','--name','axi-r2-reporter-'+id,'--network','none','--user','1000:1000','--cpus','2','--memory','2g','--read-only','--tmpfs','/tmp:rw,exec,size=256m','-e','HOME=/tmp','-e','AXI_RESULT_PATH=/evidence/native.json','-v',`${source}:/task`,'-v',`${deps}:/task/node_modules:ro`,'-v',`${reporter}:/reporters:ro`,'-v',`${dir}:/evidence`,'-w','/task','sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','node','node_modules/vitest/vitest.mjs','run','--reporter=/reporters/vitest.mjs'];
 save(join(dir,'command.json'),args);const p=Bun.spawn(args,{stdout:Bun.file(join(dir,'stdout')),stderr:Bun.file(join(dir,'stderr'))});let timeout=false;const timer=setTimeout(()=>{timeout=true;p.kill('SIGKILL')},30000);const code=await p.exited;clearTimeout(timer);
 if(timeout){await Bun.spawn(['docker','rm','-f','axi-r2-reporter-'+id],{stdout:'ignore',stderr:'ignore'}).exited}assert(!timeout);const result=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));assert.equal(result.assertionFailures.length,f.assertion?1:0);assert.equal(result.unhandled.length,0);
 if(f.state==='load-error'){assert.equal(result.tests.length,0);assert(result.suites.some((s:any)=>s.errors.length));assert.equal(code,1)}
 else{assert.equal(result.tests.length,1);assert.equal(result.tests[0].state,f.state);assert.equal(code,f.state==='fail'?1:0)}
 const row={id,repeat,passed:true,exitCode:code,state:f.state,assertion:f.assertion};rows.push(row);save(join(out,'results.json'),{qualified:rows.length===50,rows});console.log(JSON.stringify(row));
}
