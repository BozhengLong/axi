import {join} from 'node:path';
import {existsSync,rmSync} from 'node:fs';
import {command,save} from '../core.ts';
import {verifyExecution} from '../stable/execution.ts';
import {assertMayGrade} from './grading-permission.ts';
import {read,STUDY} from './config.ts';
import {profile} from './profile.ts';
import {GradingIndeterminate} from './status.ts';
import {GradeWindow} from './window.ts';
import {cleanup} from './runtime.ts';
export async function gradeInWorker(run:string,target:string,revision:string,executionProfileHash:string,deadline:number,scope:'final'|'checkpoint'='final',qualification=false){
 assertMayGrade(run,qualification);const p=profile();if(p.executionProfileHash!==executionProfileHash||p.graderRevision!==revision)throw Error('冻结版本改变');
 const seal=verifyExecution(run,executionProfileHash),path=join(target,'grades',revision,seal.id+(scope==='checkpoint'?'-checkpoint':''),'score.json');
 const window=new GradeWindow(deadline),workerMs=window.remaining('before-worker'),gradeId='trust-worker-'+Date.now()+'-'+crypto.randomUUID().slice(0,8),names=['current','old'].map(s=>'axi-v1-'+gradeId+'-'+s);
 const failurePath=join(target,seal.id+'-'+scope+'-'+gradeId+'-worker-failure.json');
 let result:any,commandError:any;
 try{result=await command(['bun','scripts/eval/reentry/grade-one.ts','--offline'],JSON.stringify({run,target,revision,executionProfileHash,deadline,scope,qualification,gradeId}),true,workerMs)}catch(error){commandError=String(error)}
 if(commandError||result.exitCode||result.timedOut||!existsSync(path)){
  // worker无法执行finally时，父进程在同一截止的清理窗口内接管已声明资源。
  let reclaimed:any,cleanupError:any;
  try{
   reclaimed=await cleanup(names,window);
   const lock=join(STUDY,'resource.lock'),ownerPath=join(lock,'owner.json');
   if(existsSync(ownerPath)){const owner=read(ownerPath);if(owner.kind==='grade:'+gradeId){let dead=false;try{process.kill(owner.pid,0)}catch(e:any){dead=e.code==='ESRCH'}if(!dead)throw Error('评分worker仍存活，不能移除其锁');rmSync(lock,{recursive:true})}}
  }catch(error){cleanupError=String(error)}
  save(failurePath,{gradeId,deadline,workerDeadline:window.workDeadline,result,commandError,reclaimed,cleanupError});
  verifyExecution(run,executionProfileHash);
  throw new GradingIndeterminate(cleanupError?'worker_cleanup_incomplete':result?.timedOut?'worker_deadline':'worker_failure',scope,{failurePath,cleanupError});
 }
 const score=read(path);verifyExecution(run,executionProfileHash);if(profile().graderRevision!==revision)throw Error('评分期间版本改变');
 if(score.artifactHash!==seal.artifactHash||score.graderRevision!==revision||score.scope!==scope)throw Error('评分身份不符');return score;
}
