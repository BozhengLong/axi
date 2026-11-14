import {join} from 'node:path';
import {command,save} from '../core.ts';
import {profile} from './profile.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
if(process.argv[2]!=='--offline')throw Error('需要 --offline');
const a=authorization(),p=profile(),results:any[]=[];
const steps:[string,string[],string?,number?][]=[
 ['unit',['bun','test']],['types',['bun','run','typecheck']],
 ['compatibility',['bun','scripts/eval/rc/stability.ts','--compatibility'],'compatibility-latest.json',10],
 ['quality',['bun','scripts/eval/rc/calibrate-quality.ts'],'quality-calibration-latest.json',5],
 ['calibration',['bun','scripts/eval/v1/calibrate.ts'],'calibration-latest.json',14],
 ['interaction',['bun','scripts/eval/v1/smoke.ts'],'smoke-latest.json',9],
 ['transport',['bun','scripts/eval/v1/transport-smoke.ts'],'transport-smoke-latest.json',7],
 ['protocol',['bun','scripts/eval/rc/protocol-smoke.ts'],'protocol-smoke-latest.json',8],
 ['pipeline',['bun','scripts/eval/rc/pipeline.ts','--mock'],'pipeline-latest.json',8],
];
let complete=false;
try{
 for(const [id,args,file,count]of steps){
  if(profile().sourceHash!==p.sourceHash)throw Error('离线门槛之间源码变化');
  if(Date.now()+30*60000>a.workDeadline)throw Error('剩余窗口不足');
  const result=await command(args,undefined,true,30*60000);save(join(STUDY,'offline',id+'.json'),result);
  let passed=result.exitCode===0&&!result.timedOut;
  if(file&&passed){const r=read(join(STUDY,file)),checks=r.results??r.checks;passed=r.complete&&r.image===IMAGE&&r.sourceHash===p.sourceHash&&checks.length===count&&checks.every((x:any)=>x.passed)}
  results.push({id,passed,exitCode:result.exitCode,evidence:file??'offline/'+id+'.json'});console.log(JSON.stringify(results.at(-1)));if(!passed)throw Error('离线门槛失败:'+id);
 }
 complete=true;
}finally{save(join(STUDY,'offline-gates.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,results})}
