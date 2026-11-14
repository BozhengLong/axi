import {join} from 'node:path';
import {command,save} from '../core.ts';
import {profile} from './profile.ts';
import {capture,unchanged} from './provenance.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
import {withResources} from './resources.ts';
if(process.argv[2]!=='--offline')throw Error('需要--offline');
const a=authorization(),p=profile(),directory=join(STUDY,'qualification-'+Date.now()),provenance=capture(directory),results:any[]=[];let complete=false;
const steps=[
 ['dependencies-before',['bun','scripts/eval/trust/dependencies.ts'],true],
 ['unit',['bun','test'],false],['types',['bun','run','typecheck'],false],
 ['compatibility',['bun','scripts/eval/trust/compatibility.ts'],false],
 ['calibration',['bun','scripts/eval/trust/calibrate.ts'],false],
 ['stability',['bun','scripts/eval/trust/stability.ts'],false],
 ['historical',['bun','scripts/eval/trust/replay.ts'],false],
 ['interaction',['bun','scripts/eval/v1/smoke.ts'],true],
 ['transport',['bun','scripts/eval/v1/transport-smoke.ts'],true],
 ['protocol',['bun','scripts/eval/trust/protocol-smoke.ts'],true],
 ['review',['bun','scripts/eval/trust/smoke.ts'],true],
 ['pipeline',['bun','scripts/eval/trust/pipeline.ts','--mock'],false],
 ['fault',['bun','scripts/eval/trust/fault-check.ts'],false],
 ['dependencies-after',['bun','scripts/eval/trust/dependencies.ts'],true],
] as const;
save(join(directory,'declared.json'),steps);
try{for(const [id,args,lock]of steps){unchanged(provenance);const run=()=>command([...args],undefined,true,Math.min(45*60000,a.workDeadline-Date.now()));const r=lock?await withResources('offline:'+id,run):await run();save(join(directory,id+'.json'),r);const passed=r.exitCode===0&&!r.timedOut;results.push({id,passed,exitCode:r.exitCode,timedOut:r.timedOut,durationMs:r.durationMs});console.log(JSON.stringify(results.at(-1)));if(!passed)throw Error('离线门槛失败:'+id)}unchanged(provenance);complete=true}finally{save(join(STUDY,'offline-gates.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,directory,results})}
