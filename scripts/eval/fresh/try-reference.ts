import {join} from 'node:path';
import {save} from '../core.ts';
import {grade} from './grade.ts';
import {reference} from './tasks.ts';
import {taskFiles} from '../v1/tasks.ts';
import {FRESH,tasks,preparationGate} from './settings.ts';
const a=preparationGate(),directory=join(FRESH,'try-reference-'+Date.now()),rows=[];
for(const task of tasks){const r=await grade(task,'try-ref-'+task+'-'+Date.now(),taskFiles(task),reference(task),join(directory,task),{deadline:a.workDeadline});const row={task,code:r.codePassed,regression:r.regressionPassed,failed:r.checks.filter(c=>!c.pass).map(c=>c.id)};rows.push(row);save(join(FRESH,'try-reference-latest.json'),{directory,rows});console.log(JSON.stringify(row));if(!r.codePassed||!r.regressionPassed)throw Error('参考不通过')}
