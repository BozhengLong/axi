import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {ROOT,type Snapshot} from '../core.ts';
import {file,taskFiles} from '../v1/tasks.ts';
import type {FreshTask} from './settings.ts';
export const fixture=(name:string)=>readFileSync(join(ROOT,'evals/v1-fresh-v1',name+'.fixture'),'utf8');
export function reference(task:FreshTask,regression=true):Snapshot{
 const result=structuredClone(taskFiles(task)),id=task.slice(-1);
 for(const path of ['index.js','index.d.ts','readme.md'])result[path]=file(fixture(`reference/${id}-${path}`));
 if(regression)result['eval-tests/reference.test.mjs']=file(fixture(`reference/${id}-test.mjs`));
 return result;
}
