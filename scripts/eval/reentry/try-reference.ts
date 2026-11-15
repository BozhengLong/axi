import {join} from 'node:path';
import {save} from '../core.ts';
import {taskFiles} from '../v1/tasks.ts';
import {grade} from './grade.ts';
import {reference} from './tasks.ts';
import {STUDY,tasks,authorization} from './config.ts';
const a=authorization(),stamp=Date.now(),directory=join(STUDY,'reference-check-'+stamp),rows=[];
for(const task of tasks)for(const variant of ['primary','alternative']as const){
 const r=await grade(task,`trust-ref-${stamp}-${rows.length}`,taskFiles(task),reference(task,variant),join(directory,task+'-'+variant),{deadline:a.workDeadline});
 const row={task,variant,code:r.codePassed,regression:r.regressionPassed,failures:r.checks.filter(x=>!x.pass).map(x=>x.id)};rows.push(row);save(join(STUDY,'reference-check-latest.json'),{directory,rows,complete:rows.length===4&&rows.every(x=>x.code&&x.regression)});console.log(JSON.stringify(row));if(!row.code||!row.regression)throw Error('参考未通过');
}
