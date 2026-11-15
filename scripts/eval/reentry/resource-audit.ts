import {join} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {ROOT,save,execute} from '../core.ts';
import {file} from '../v1/tasks.ts';
import {lazyTimerReference} from './calibration-material.ts';
import {executableOracle as priorMeasurement} from '../trust/measurement.ts';
import {executableOracle} from './measurement.ts';
import {fixture} from './tasks.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {testReport,passedTests} from './status.ts';
import {capture,unchanged} from './provenance.ts';
import {withResources} from './resources.ts';
import {STUDY,IMAGE} from './config.ts';
const directory=join(STUDY,'resource-measurement-audit-'+Date.now()),p=capture(directory),rows:any[]=[];let complete=false;
try{await withResources('resource-audit',async()=>{
 const window=new GradeWindow(Date.now()+60000),name='axi-reentry-resource-'+Date.now();
 try{
  const prior=priorMeasurement('V1-D',readFileSync(join(ROOT,'evals/v1-trust-dev-v1/oracle/D-test.mjs.fixture'),'utf8')).source,current=executableOracle('V1-D',fixture('oracle/D-test.mjs')).source;
  const r=await isolated(IMAGE,'V1-D',name,{...lazyTimerReference(),'eval-audit/prior.test.mjs':file(prior),'eval-audit/current.test.mjs':file(current)},window);
  for(const [version,source]of [['prior',prior],['current',current]]){
   mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(join(directory,version+'.test.mjs'),source!,{mode:0o600});
   const report=testReport(await execute(r,['node','--test','--test-reporter=tap','--test-name-pattern','^D13 ','eval-audit/'+version+'.test.mjs'],undefined,true,window.remaining(version!)),version!);
   const expected=version==='current'?passedTests(report,1):report.failed>0&&report.assertionFailure&&report.stdout.includes('unrefs>=4');
   rows.push({version,passed:expected,report});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({version,passed:expected}));if(!expected)throw Error('资源约束对照与预期不符');
  }
 }finally{save(join(directory,'cleanup.json'),await cleanup([name],window))}
});unchanged(p);complete=true}finally{save(join(STUDY,'resource-audit-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows})}
