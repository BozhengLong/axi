import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT,type Snapshot} from '../core.ts';
import {taskFiles as c7Files,clean,file,contents,snapshotHash} from '../c7/tasks.ts';
import {STUDY,type TaskId} from './settings.ts';
export {clean,file,contents,snapshotHash};
export const isHoldout=(task:TaskId)=>task.startsWith('V1-');
export const taskManifest=(task:TaskId)=>JSON.parse(readFileSync(join(STUDY,'tasks',task.slice(-1),'manifest.json'),'utf8'));
export function taskFiles(task:TaskId):Snapshot{
 if(task==='C7-L'||task==='C7-O')return c7Files(task);
 const files=JSON.parse(readFileSync(join(STUDY,'tasks',task.slice(-1),'input.json'),'utf8'));
 if(snapshotHash(files)!==taskManifest(task).inputSha256)throw Error('冻结输入被改变');return files;
}
export const fixture=(name:string)=>readFileSync(join(ROOT,'evals/v1-holdout-v1',name+'.fixture'),'utf8');
export function reference(task:TaskId):Snapshot{
 const s=structuredClone(taskFiles(task)),id=task.slice(-1);
 for(const p of ['index.js','index.d.ts','readme.md'])s[p]=file(fixture(`reference/${id}-${p}`));
 s['eval-tests/reference.test.mjs']=file(fixture(`reference/${id}-test.mjs`));return s;
}
