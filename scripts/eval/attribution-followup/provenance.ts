import {join,dirname} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {ROOT,save} from '../core.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {taskManifest,taskFiles,snapshotHash} from '../v1/tasks.ts';
import {IMAGE,allTasks as tasks} from './config.ts';
export function capture(directory:string){
 const p=fingerprint();
 for(const path of Object.keys(p.hashes)){const dest=join(directory,'source-snapshot',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,readFileSync(join(ROOT,path)),{mode:0o600})}
 const inputs=Object.fromEntries(tasks.map(task=>{const files=taskFiles(task);save(join(directory,'inputs',task+'.json'),files);return [task,{manifest:taskManifest(task),sha256:snapshotHash(files)}]}));
 save(join(directory,'source-manifest.json'),{...p,image:IMAGE,inputs,capturedAt:new Date().toISOString()});return p;
}
export function unchanged(p:ReturnType<typeof fingerprint>){if(fingerprint().sourceHash!==p.sourceHash)throw Error('检查期间源码改变，不能把该次结果当作当前版本资格')}
