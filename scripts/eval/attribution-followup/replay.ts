import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {snapshotHash} from '../v1/tasks.ts';
import {grade} from './grade.ts';
import {grade as oldGrade} from '../attribution/grade.ts';
import {capture,unchanged} from './provenance.ts';
import {STUDY,HISTORY,read,authorization} from './config.ts';
const a=authorization(),directory=join(STUDY,'historical-replay-'+Date.now()),p=capture(directory),rows:any[]=[];let complete=false;
const materials=read(join(HISTORY,'attribution.json')).rows;
const views=materials.flatMap((item:any)=>[{item,scope:'final'},...(item.checkpointScore?[{item,scope:'checkpoint'}]:[])]);
if(views.length!==9)throw Error('历史封存视图不符');
save(join(directory,'declared.json'),{views:9,materials:views.map(({item,scope}:any)=>({id:item.execution.id,scope,run:item.execution.runDirectory})),expectations:{old:'all 9 machine views unchanged',new:'only adds WAITING_SEMANTICS; P1 positives and D remain positive; P3 all-pending interpretations fail E09S-04/E09S-06/E09S-11/E09X-04; old semantic indeterminacy is not rewritten'}});
try{for(const {item,scope} of views){
 const x=item.execution,run=x.runDirectory,seal=verifyExecution(run),seed=read(join(run,'initial-files.json')),manifest=read(join(HISTORY,'tasks',x.task.slice(-1),'manifest.json'));
 const candidate=read(join(run,scope==='final'?'final-files.json':'review-checkpoint-files.json')),prior=scope==='final'?item.score:item.checkpointScore;
 for(const mode of ['old','new'] as const){
  unchanged(p);const r=await(mode==='old'?oldGrade:grade)(x.task,'followup-replay-'+Date.now(),seed,candidate,join(directory,x.id+'-'+scope+'-'+mode),{deadline:Math.min(Date.now()+900000,a.workDeadline),manifest,git:read(join(run,scope==='final'?'final-git.json':'review-checkpoint-git.json')),initialGit:read(join(run,'initial-git.json'))});
  verifyExecution(run);const failures=r.checks.filter(c=>!c.pass).map(c=>c.id),existing=failures.filter(c=>c!=='WAITING_SEMANTICS');
  const waitingFailures=[...((r.logs.waiting as any)?.stdout??'').matchAll(/^not ok \d+ - (E09[XS]-\d+)/gm)].map((m:any)=>m[1]).sort();
  const expectedWaiting=mode==='new'&&x.id.startsWith('P3-')?['E09S-04','E09S-06','E09S-11','E09X-04']:[];
  const passed=r.regressionPassed===prior.regressionPassed&&JSON.stringify(existing)===JSON.stringify(prior.failureChecks)&&JSON.stringify(waitingFailures)===JSON.stringify(expectedWaiting)&&(mode==='new'||r.codePassed===prior.codePassed);
  rows.push({id:x.id,scope,mode,artifactHash:seal.artifactHash,viewHash:snapshotHash(candidate),priorOfficialScore:prior,code:r.codePassed,regression:r.regressionPassed,failures,waitingFailures,passed});save(join(directory,'rows.json'),rows);console.log(JSON.stringify({id:x.id,scope,mode,passed,failures,waitingFailures}));if(!passed)throw Error('历史诊断与预声明不同，需要审查；不得改旧成绩');
 }
}unchanged(p);complete=rows.length===18}finally{save(join(STUDY,'historical-replay-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows,meaning:'9个旧视图各按旧机判回放与新契约诊断，不计新样本'})}
