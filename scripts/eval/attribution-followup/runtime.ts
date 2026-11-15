import {docker,type Snapshot} from '../core.ts';
import {mounts} from '../v1/runtime.ts';
import type {TaskId} from '../v1/settings.ts';
import {GradeWindow} from './window.ts';
import {GradingIndeterminate} from './status.ts';
export async function isolated(image:string,task:TaskId,name:string,files:Snapshot,window:GradeWindow){
 const records:any[]=[];const run=async(args:string[],input?:string)=>{const allocatedMs=window.remaining('sandbox-init'),r=await docker(args,input,true,allocatedMs);records.push({args,allocatedMs,deadline:window.deadline,result:r});if(r.exitCode||r.timedOut)throw new GradingIndeterminate('sandbox_init','restore',records);return r};
 await run(['volume','create','--label','axi.eval.study=v1-attribution-followup-20261116',name]);
 await run(['run','--rm','--name',name+'-init-own','--network','none','--entrypoint','chown','--mount',`type=volume,src=${name},dst=/task`,image,'1000:1000','/task']);
 await run(['run','--rm','--name',name+'-init-restore','-i','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--mount',`type=volume,src=${name},dst=/task`,image,'bun','/opt/eval/c6-files.ts','restore'],JSON.stringify(files));
 await run(['run','-d','--name',name,'--label','axi.eval.study=v1-attribution-followup-20261116','--network','none','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=SETUID','--cap-add=SETGID','--cap-add=SETPCAP','--security-opt','no-new-privileges','--cpus','2','--memory','4g','--pids-limit','256','--mount',`type=volume,src=${name},dst=/task`,...mounts(task).flatMap(m=>['--mount',m]),'--tmpfs','/home/eval:rw,nosuid,size=128m','--tmpfs','/tmp:rw,nosuid,size=512m',image]);
 return {name,volume:name,initLog:records};
}
export async function cleanup(names:string[],window:GradeWindow){
 const records=[];
 for(const name of names){
  // rm -f不存在的容器会返回错误，最终inspect才是是否清理成功的依据。
  const removed=await docker(['rm','-f',name,name+'-init-own',name+'-init-restore'],undefined,true,window.remaining('container-cleanup',true));
  const volume=await docker(['volume','rm',name],undefined,true,window.remaining('volume-cleanup',true));
  const containerCheck=await docker(['container','inspect',name],undefined,true,window.remaining('container-check',true));
  const helperChecks=[];for(const helperName of [name+'-init-own',name+'-init-restore'])helperChecks.push(await docker(['container','inspect',helperName],undefined,true,window.remaining('helper-check',true)));
  const volumeCheck=await docker(['volume','inspect',name],undefined,true,window.remaining('volume-check',true));
  const gone=helperChecks.every(r=>r.exitCode!==0&&/No such|not found/i.test(r.stderr))&&containerCheck.exitCode!==0&&volumeCheck.exitCode!==0&&/No such|not found/i.test(containerCheck.stderr)&&/No such|not found/i.test(volumeCheck.stderr);
  records.push({name,gone,removed,volume,containerCheck,volumeCheck,helperChecks});if(!gone)throw new GradingIndeterminate('cleanup_incomplete',name,records);
 }
 return records;
}
