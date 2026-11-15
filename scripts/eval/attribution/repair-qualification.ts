import {join} from 'node:path';
import {save} from '../core.ts';
import {taskFiles} from '../v1/tasks.ts';
import {capture,unchanged} from './provenance.ts';
import {reference} from './tasks.ts';
import {grade} from './grade.ts';
import {STUDY,authorization} from './config.ts';
const a=authorization(),directory=join(STUDY,'repair-qualification-'+Date.now()),p=capture(directory),rows:any[]=[];
const declared=Array.from({length:5},(_,i)=>(['V1-U','V1-Q']as const).flatMap(task=>(['baseline','primary','alternative']as const).map(variant=>({repeat:i+1,task,variant})))).flat();
save(join(directory,'declared.json'),{cases:declared,targetFailures:['S119','S120','S125','S126'],allOtherChecksMustPass:true});let complete=false;
try{for(const c of declared){
 unchanged(p);const r=await grade(c.task,'attribution-q-'+Date.now(),taskFiles(c.task),c.variant==='baseline'?taskFiles(c.task):reference(c.task,c.variant),join(directory,`${c.task}-${c.variant}-${c.repeat}`),{regression:c.variant!=='baseline',deadline:a.workDeadline});
 const failures=r.checks.filter(x=>!x.pass).map(x=>x.id),targets=[...(r.logs.reentry as any).stdout.matchAll(/^not ok \d+ - (S\d+)/gm)].map(m=>m[1]).sort();
 const passed=c.variant==='baseline'?JSON.stringify(failures)===JSON.stringify(['REENTRY'])&&JSON.stringify(targets)===JSON.stringify(['S119','S120','S125','S126']):r.codePassed&&r.regressionPassed;
 rows.push({...c,passed,failures,targets,code:r.codePassed,regression:r.regressionPassed});save(join(directory,'rows.json'),rows);console.log(JSON.stringify(rows.at(-1)));if(!passed)throw Error('修复题没有满足预先声明的单缺陷资格');
}unchanged(p);complete=rows.length===30}finally{save(join(STUDY,'repair-qualification-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows})}
