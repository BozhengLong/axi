import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {save,STORE,ROOT} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {taskFiles,file,snapshotHash} from '../v1/tasks.ts';
import {grade} from './grade.ts';
import {reference} from './tasks.ts';
import {capture,unchanged} from './provenance.ts';
import {STUDY,HISTORY,read,authorization,type DevTask} from './config.ts';
const a=authorization(),directory=join(STUDY,'historical-replay-'+Date.now()),p=capture(directory),latest=join(STORE,'v1-trust-20261115'),rows:any[]=[];let complete=false;
const materials=[...read(join(HISTORY,'fresh/state.json')).rows.map((item:any)=>({item,study:HISTORY,group:'historical'})),...read(join(latest,'development.json')).rows.map((item:any)=>({item,study:latest,group:'last-development'}))];
save(join(directory,'declared.json'),{views:16,referenceDiagnostics:3,materials:materials.map(({item,study,group})=>({id:item.execution.id,run:item.execution.runDirectory,study,group})),expectations:'historical E fails E21 and reentry; historical D fails D20 (old/Claude also D08); last E fails reentry; last D passes; old reference and minimal fix diagnoses do not define truth'});
try{
 for(const {item,study,group}of materials){
  const x=item.execution,run=x.runDirectory,seal=verifyExecution(run),task=x.task as DevTask;
  const deadline=Math.min(Date.now()+900000,a.workDeadline),seed=read(join(run,'initial-files.json')),manifest=read(join(study,'tasks',task.slice(-1),'manifest.json'));
  for(const scope of ['final','checkpoint'] as const){
   if(scope==='checkpoint'&&!existsSync(join(run,'review-checkpoint-files.json')))continue;
   unchanged(p);const candidate=read(join(run,scope==='final'?'final-files.json':'review-checkpoint-files.json'));
   const r=await grade(task,'reentry-replay-'+Date.now(),seed,candidate,join(directory,group+'-'+x.id+'-'+scope),{deadline,manifest,git:read(join(run,scope==='final'?'final-git.json':'review-checkpoint-git.json')),initialGit:read(join(run,'initial-git.json'))});
   verifyExecution(run);const contract=r.logs.contract as any;
   const targets=group==='historical'?(task==='V1-E'?['E21']:(x.variant==='new'?['D20']:['D08','D20'])):[];
   const expectedTargets=targets.every(t=>new RegExp('not ok \\d+ - '+t+' ').test(contract.stdout));
   const expectedCode=group==='last-development'&&task==='V1-D';
   const reentryDetected=task!=='V1-E'||r.checks.some(c=>c.id==='REENTRY'&&!c.pass);
   const row={id:x.id,group,scope,artifactHash:seal.artifactHash,viewHash:snapshotHash(candidate),priorOfficialScore:(scope==='final'?item.score:item.checkpointScore)??null,contractVersion:'reentry-development-v1',code:r.codePassed,regression:r.regressionPassed,failedChecks:r.checks.filter(c=>!c.pass).map(c=>c.id),targets,expectedTargets,reentryDetected,passed:r.codePassed===expectedCode&&r.regressionPassed&&expectedTargets&&reentryDetected};
   rows.push(row);save(join(directory,'rows.json'),rows);console.log(JSON.stringify({...row,priorOfficialScore:'archived'}));if(!row.passed)throw Error('历史回放与声明的缺陷或有效回归不符');
  }
 }
 const diagnostics=[];const priorProbe=read(join(latest,'reentrancy-diagnostic-latest.json'));
 for(const variant of ['primary','alternative','minimal-repair']){
  unchanged(p);let candidate;
  if(variant==='minimal-repair')candidate=read(join(priorProbe.directory,'human-repair-control-files.json'));
  else{candidate=reference('V1-E');for(const path of ['index.ts','readme.md'])candidate[path]=file(readFileSync(join(ROOT,'evals/v1-trust-dev-v1',variant==='primary'?'reference':'alternative','E-'+path+'.fixture'),'utf8'))}
  // 人工修复只改旧产物的代码，必须用它对应的旧初态比较保护文件；新题面不是该产物的接手版本。
  const original=variant==='minimal-repair'?materials.find(m=>m.group==='last-development'&&m.item.product==='current'&&m.item.execution.task==='V1-E'):undefined;
  if(variant==='minimal-repair'&&!original)throw Error('缺少人工最小修复对应初态');
  const seed=original?read(join(original.item.execution.runDirectory,'initial-files.json')):taskFiles('V1-E');
  const manifest=original?read(join(latest,'tasks/E/manifest.json')):undefined;
  const r=await grade('V1-E','reentry-old-ref-'+Date.now(),seed,candidate,join(directory,'diagnostic-'+variant),{manifest,deadline:Math.min(Date.now()+900000,a.workDeadline)});
  if(!r.checks.find(c=>c.id==='PROTECT')?.pass)throw Error('参考诊断的保护文件与对应初态不一致');
  diagnostics.push({variant,viewHash:snapshotHash(candidate),code:r.codePassed,regression:r.regressionPassed,failures:r.checks.filter(c=>!c.pass).map(c=>c.id),meaning:'资格材料；不是新参考或模型成绩'});save(join(directory,'reference-diagnostics.json'),diagnostics);
  if(variant!=='minimal-repair'&&!r.checks.some(c=>c.id==='REENTRY'&&!c.pass))throw Error('旧参考已确认缺陷未被检出');
 }
 unchanged(p);complete=rows.length===16&&diagnostics.length===3;
}finally{save(join(STUDY,'historical-replay-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows,meaning:'新契约离线资格；历史分数不变，不计模型成功'})}
