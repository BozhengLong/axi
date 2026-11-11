import {join} from 'node:path';
import {createRuntime,docker,execute,save,type Batch,type Snapshot,type Runtime} from '../core.ts';
import {helper,dependencyMounts} from '../c6/runtime.ts';
import {prepareGit as c7Git,gitState,snapshot,cleanup} from '../c7/runtime.ts';
import {POLICY_PATH,POLICY_BASE,NOTES_PATH} from '../c6/settings.ts';
import {file,taskManifest} from './tasks.ts';
import type {TaskId} from './settings.ts';
export {gitState,snapshot,cleanup};
export const mounts=(task:TaskId)=>task==='C7-L'?dependencyMounts():task==='C7-O'?[]:[`type=volume,src=${taskManifest(task).dependencyVolume},dst=/task/node_modules,volume-subpath=node_modules,readonly`];
export async function newVolume(image:string,name:string,files:Snapshot){
 await docker(['volume','create','--label','axi.eval.study=v1-20261112',name]);
 await docker(['run','--rm','--network','none','--entrypoint','chown','--mount',`type=volume,src=${name},dst=/task`,image,'1000:1000','/task']);
 const r=await helper(image,name,['bun','/opt/eval/c6-files.ts','restore'],true,JSON.stringify(files));if(r.exitCode)throw Error(r.stderr);
}
export async function isolated(image:string,task:TaskId,id:string,files:Snapshot){
 const name=`axi-v1-${id}`;await newVolume(image,name,files);
 try{await docker(['run','-d','--name',name,'--label','axi.eval.study=v1-20261112','--network','none','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=SETUID','--cap-add=SETGID','--cap-add=SETPCAP','--security-opt','no-new-privileges','--cpus','2','--memory','4g','--pids-limit','256','--mount',`type=volume,src=${name},dst=/task`,...mounts(task).flatMap(m=>['--mount',m]),'--tmpfs','/home/eval:rw,nosuid,size=128m','--tmpfs','/tmp:rw,nosuid,size=512m',image]);}
 catch(e){await docker(['volume','rm',name],undefined,true);throw e;}
 return {name,volume:name,close:async()=>{await docker(['rm','-f',name],undefined,true);await docker(['volume','rm',name],undefined,true);}};
}
export async function runtime(batch:Batch,task:TaskId,id:string,files:Snapshot,mock?:unknown[]){
 const volume=`axi-v1-${batch.id}-${id}`,base={...files};
 if(task==='C7-L'){base[POLICY_PATH]=file(POLICY_BASE);delete base[NOTES_PATH];}
 if(task.startsWith('V1-')){base['user/policy.txt']=file('用户原有策略。\r\n',0o640);delete base['user/notes.txt'];}
 await newVolume(batch.image,volume,base);
 try{return await createRuntime(batch,id,{taskVolume:volume,mounts:mounts(task),maxRounds:1,maxTotal:50,mock});}
 catch(e){await docker(['volume','rm',volume],undefined,true);throw e;}
}
export async function prepareGit(batch:Batch,r:Runtime,task:TaskId,seed:Snapshot){
 if(task==='C7-L'||task==='C7-O')return c7Git(batch,r,task,seed);
 await execute(r,['git','init','-q','-b','main']);
 const paths=Object.keys(seed).filter(p=>p!=='user/notes.txt');
 await execute(r,['git','add','--force','--pathspec-from-file=-','--pathspec-file-nul'],paths.join('\0')+'\0');
 await execute(r,['env','GIT_AUTHOR_NAME=Evaluation','GIT_COMMITTER_NAME=Evaluation','GIT_AUTHOR_EMAIL=eval@example.invalid','GIT_COMMITTER_EMAIL=eval@example.invalid','GIT_AUTHOR_DATE=2026-11-12T02:00:00Z','GIT_COMMITTER_DATE=2026-11-12T02:00:00Z','git','-c','core.hooksPath=/dev/null','commit','-qm',`冻结 ${task} 起点`]);
 const patch=await helper(batch.image,r.taskVolume!,['bun','/opt/eval/c6-files.ts','patch'],true,JSON.stringify({'user/policy.txt':seed['user/policy.txt'],'user/notes.txt':seed['user/notes.txt']}));if(patch.exitCode)throw Error(patch.stderr);
 const state=await gitState(r);save(join(r.directory,'initial-git.json'),state);return state;
}
