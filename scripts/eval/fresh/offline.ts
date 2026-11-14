import {join} from 'node:path';
import {command,save} from '../core.ts';
import {profile} from './profile.ts';
import {FRESH,IMAGE} from './settings.ts';
const p=profile(),results:{name:string;passed:boolean;exitCode:number;timedOut:boolean;durationMs:number}[]=[];let complete=false;
const checks=[['tests',['bun','test']],['types',['bun','run','typecheck']],['calibration',['bun','scripts/eval/fresh/calibrate.ts']],['pipeline',['bun','scripts/eval/fresh/pipeline.ts','--mock']],['grader-fault',['bun','scripts/eval/fresh/fault-check.ts']]] as const;
const persist=()=>save(join(FRESH,'offline-gates.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,results});
try{for(const [name,args]of checks){if(profile().sourceHash!==p.sourceHash)throw Error('离线门槛期间源码改变');const r=await command([...args],undefined,true,Math.min(30*60000,p.authorization.workDeadline-Date.now()));save(join(FRESH,'offline-'+name+'.json'),r);results.push({name,passed:r.exitCode===0&&!r.timedOut,exitCode:r.exitCode,timedOut:r.timedOut,durationMs:r.durationMs});persist();console.log(JSON.stringify(results.at(-1)));if(r.exitCode||r.timedOut)throw Error('离线门槛失败:'+name)}if(profile().sourceHash!==p.sourceHash)throw Error('源码改变');complete=true}finally{persist()}
