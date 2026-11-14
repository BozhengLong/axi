import {join} from 'node:path';
import {save} from '../core.ts';
import {taskFiles} from '../v1/tasks.ts';
import {capture,unchanged} from './provenance.ts';
import {reference} from './tasks.ts';
import {nativeOnceReference} from './calibration-material.ts';
import {grade} from './grade.ts';
import {STUDY,tasks,authorization} from './config.ts';
const a=authorization(),directory=join(STUDY,'stability-'+Date.now()),p=capture(directory),rows:any[]=[];
const declared=Array.from({length:5},(_,i)=>tasks.flatMap(task=>(task==='V1-D'?['baseline','primary','alternative','native-once']:['baseline','primary','alternative']).map(variant=>({repeat:i+1,task,variant})))).flat();
save(join(directory,'declared.json'),declared);let complete=false;
try{for(const c of declared){
 unchanged(p);const r=await grade(c.task,'trust-repeat-'+Date.now(),taskFiles(c.task),c.variant==='baseline'?taskFiles(c.task):c.variant==='native-once'?nativeOnceReference():reference(c.task,c.variant as 'primary'|'alternative'),join(directory,`${c.task}-${c.variant}-${c.repeat}`),{regression:c.variant!=='baseline',deadline:a.workDeadline});
 const upstream=r.checks.filter(x=>['构建','原运行测试','原类型测试'].includes(x.id));
 const passed=upstream.length===(c.task==='V1-E'?3:2)&&upstream.every(x=>x.pass)&&(c.variant==='baseline'?!r.codePassed:r.codePassed&&r.regressionPassed);
 rows.push({...c,passed,code:r.codePassed,regression:r.regressionPassed});save(join(directory,'rows.json'),rows);console.log(JSON.stringify(rows.at(-1)));if(!passed)throw Error('预先声明的重复检查失败，不筛掉失败后续跑');
}unchanged(p);complete=rows.length===35}finally{save(join(STUDY,'stability-latest.json'),{complete,sourceHash:p.sourceHash,directory,rows})}
