import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {ROOT,execute,save} from '../core.ts';
import {file} from '../v1/tasks.ts';
import {fixture,reference} from './tasks.ts';
import {STUDY,IMAGE,authorization,read} from './config.ts';
import {withResources} from './resources.ts';
import {isolated,cleanup} from './runtime.ts';
import {GradeWindow} from './window.ts';
import {testReport,passedTests} from './status.ts';
import {capture,unchanged} from './provenance.ts';
const a=authorization(),directory=join(STUDY,'waiting-qualification-'+Date.now()),statePath=join(STUDY,'attribution.json');
const limit=existsSync(statePath)&&read(statePath).repair?.deadline?Math.min(a.workDeadline,read(statePath).repair.deadline):a.preparationDeadline;
if(Date.now()>=limit)throw Error('等待语义资格窗口已结束');
const provenance=capture(directory);
const specs=JSON.parse(readFileSync(join(ROOT,'evals/specs/v1-attribution-followup-v1/waiting-cases.json'),'utf8'));
const declared=[...['latest','latest-immediate','latest-delayed','all-pending','cure','first-only','skip-later','wrong-waiter-error'].map(mode=>({kind:'witness',mode,expectedFailures:specs.witnessFailures[mode]})),...['primary','alternative'].map(mode=>({kind:'reference',mode,expectedFailures:[]}))];
save(join(directory,'declared.json'),declared);const rows:any[]=[];let complete=false;
try{for(const c of declared){await withResources('waiting:'+c.mode,async()=>{
 const window=new GradeWindow(Math.min(Date.now()+900000,limit)),name='axi-followup-waiting-'+Date.now();
 try{
  const seed=reference('V1-E',c.mode==='alternative'?'alternative':'primary',false);
  let source=fixture('oracle/E-waiting.mjs');
  if(c.kind==='witness'){
   seed['eval-oracle/witness.mjs']=file(fixture('waiting-witness.mjs'));
   source=source.replace("import * as api from '../dist/index.js';",`import {createWitness} from './witness.mjs';const api=createWitness(${JSON.stringify(c.mode)});`);
  }
  seed['eval-oracle/waiting.test.mjs']=file(source);
  const r=await isolated(IMAGE,'V1-E',name,seed,window);
  if(c.kind==='reference'){
   const build=await execute(r,['bash','-lc','npm run build'],undefined,true,window.remaining('build'));save(join(directory,c.mode+'-build.json'),build);if(build.exitCode||build.timedOut)throw Error('等待语义参考构建失败');
  }
  const filtered=c.mode==='wrong-waiter-error',total=filtered?1:19;
  const result=await execute(r,['node','--test','--test-reporter=tap',...(filtered?['--test-name-pattern','^E09X-01 ']:[]),'eval-oracle/waiting.test.mjs'],undefined,true,window.remaining('waiting-tests'));
  save(join(directory,c.kind+'-'+c.mode+'.json'),result);const parsed=testReport(result,'waiting-semantics');
  const failures=[...result.stdout.matchAll(/^not ok \d+ - (E09[XS]-\d+)/gm)].map(m=>m[1]).sort();
  const passed=parsed.total===total&&parsed.cancelled===0&&parsed.skipped===0&&JSON.stringify(failures)===JSON.stringify([...c.expectedFailures].sort())&&(failures.length?parsed.assertionFailure:passedTests(parsed,total));
  const row={...c,passed,failures,total:parsed.total};rows.push(row);console.log(JSON.stringify(row));if(!passed)throw Error('等待规范未取得预声明结果');
 }finally{save(join(directory,c.kind+'-'+c.mode+'-cleanup.json'),await cleanup([name],window))}
})}unchanged(provenance);complete=true}finally{save(join(STUDY,'waiting-qualification-latest.json'),{complete,sourceHash:provenance.sourceHash,directory,rows})}
