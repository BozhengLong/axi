import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {ROOT,type Snapshot} from '../core.ts';
import {file,taskFiles} from '../v1/tasks.ts';
import type {DevTask} from './config.ts';
export const fixture=(name:string)=>readFileSync(join(ROOT,'evals/v1-reentry-dev-v1',name+'.fixture'),'utf8');
export function reference(task:DevTask,variant:'primary'|'alternative'='primary',regression=true):Snapshot{
 const result=structuredClone(taskFiles(task)),id=task.slice(-1),prefix=variant==='primary'?'reference':'alternative';
 for(const path of task==='V1-E'?['index.ts','readme.md']:['index.js','index.d.ts','readme.md'])result[path]=file(fixture(`${prefix}/${id}-${path}`));
 if(regression)result['eval-tests/reference.test.mjs']=file(fixture(`reference/${id}-test.mjs`));
 return result;
}
