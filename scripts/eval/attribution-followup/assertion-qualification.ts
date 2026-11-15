import {join} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {docker,save,ROOT} from '../core.ts';
import {STUDY,IMAGE} from './config.ts';
import {capture,unchanged} from './provenance.ts';
import {withResources} from './resources.ts';
import {testReport,GradingIndeterminate} from './status.ts';

const directory=join(STUDY,'assertion-qualification-'+Date.now());mkdirSync(directory,{recursive:true,mode:0o700});
const provenance=capture(directory),rows:any[]=[];let complete=false;
const prefix="import test from 'node:test';import assert from 'node:assert/strict';\n";
const cases=[
 {id:'promise-1',body:"test('identity',()=>assert.equal(Promise.resolve(1),Promise.resolve(1)));",assertion:true,old:false},
 {id:'promise-2',body:"test('identity',()=>assert.equal(Promise.resolve(1),Promise.resolve(1)));",assertion:true,old:false},
 {id:'function',body:"test('identity',()=>assert.equal(()=>1,()=>1));",assertion:true,old:true},
 {id:'scalar',body:"test('scalar',()=>assert.equal(1,2));",assertion:true,old:true},
 {id:'async-assertion',body:"test('async',async()=>{await Promise.resolve();assert.equal(1,2)});",assertion:true,old:true},
 {id:'ordinary',body:"test('ordinary',()=>{throw Error('Expected actual to be reference-equal to expected')});",assertion:false,old:false},
 {id:'misleading-text',body:"test('ordinary',()=>{throw Error('AssertionError [ERR_ASSERTION]: example text')});",assertion:false,old:true},
 {id:'syntax',body:'const broken = ;',assertion:false,old:false},
 {id:'import',body:"import './nonexistent.mjs';",assertion:false,old:false},
 {id:'pass',body:"test('pass',()=>assert.equal(1,1));",assertion:false,old:false},
 {id:'skipped',body:"test.skip('skip',()=>assert.equal(1,2));",assertion:false,old:false},
 {id:'cancelled',body:"test('pending',async()=>new Promise(()=>{}));",origin:'test_cancellation'},
 {id:'timeout',body:"test('timeout',{timeout:20},async()=>new Promise(r=>setTimeout(r,100)));",origin:'test_runner_timeout'},
] as const;
save(join(directory,'declared.json'),cases);
try{await withResources('assertion-qualification',async()=>{
 const reporter=readFileSync(join(ROOT,'scripts/eval/attribution-followup/assertion-reporter.mjs'));
 writeFileSync(join(directory,'reporter.mjs'),reporter,{mode:0o600});
 for(const item of cases){
  const caseDir=join(directory,item.id);mkdirSync(caseDir,{mode:0o700});writeFileSync(join(caseDir,'case.test.mjs'),prefix+item.body,{mode:0o600});
  const reports:any={};
  for(const format of ['tap','events']as const){
   const r=await docker(['run','--rm','--network','none','--read-only','--cpus','2','--memory','1g','--label','axi.eval.study=v1-attribution-followup-20261116','--mount',`type=bind,src=${directory},dst=/qualification,readonly`,'--entrypoint','node',IMAGE,'--test','--test-reporter='+(format==='tap'?'tap':'/qualification/reporter.mjs'),'/qualification/'+item.id+'/case.test.mjs'],undefined,true,30000);
   save(join(caseDir,format+'.json'),r);
   try{reports[format]=testReport(r,item.id,format==='tap'?'tap':'native-events')}catch(error){if(!(error instanceof GradingIndeterminate))throw error;reports[format]={origin:error.origin}}
  }
  const passed='origin'in item?reports.tap.origin===item.origin&&reports.events.origin===item.origin:reports.tap.assertionFailure===item.old&&reports.events.assertionFailure===item.assertion&&['exitCode','total','passed','failed','skipped','cancelled'].every(k=>reports.tap[k]===reports.events[k]);
  rows.push({id:item.id,passed,reports});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({id:item.id,passed}));if(!passed)throw Error('断言测量资格不符:'+item.id);
 }
});unchanged(provenance);complete=true}finally{save(join(STUDY,'assertion-qualification-latest.json'),{complete,sourceHash:provenance.sourceHash,directory,rows})}
