import {join} from 'node:path';
import {command,save} from '../core.ts';
import {profile} from './profile.ts';
import {capture,unchanged} from './provenance.ts';
import {authorization,assertPreparation,STUDY,IMAGE,read} from './config.ts';
import {withResources} from './resources.ts';
if(!['--offline','--repair'].includes(process.argv[2]??''))throw Error('需要--offline或--repair');
const repairing=process.argv[2]==='--repair',a=repairing?authorization():assertPreparation(),p=profile();
if(repairing&&(p.graderEpoch!==1||read(join(STUDY,'attribution.json')).phase!=='grade_repair_required'))throw Error('没有已声明的评分恢复');
const limit=repairing?a.workDeadline:a.preparationDeadline,directory=join(STUDY,'qualification-'+Date.now()),provenance=capture(directory),results:any[]=[];let complete=false;
const steps=[
 ['input-audit',['bun','scripts/eval/attribution/input-audit.ts'],false],
 ['dependencies-before',['bun','scripts/eval/attribution/dependencies.ts'],true],
 ['unit',['bun','test'],false],['types',['bun','run','typecheck'],false],
 ['compatibility',['bun','scripts/eval/attribution/compatibility.ts'],false],
 ['registration-compatibility',['bun','scripts/eval/attribution/registration-compatibility.mjs'],false],
 ['resource-measurement',['bun','scripts/eval/attribution/resource-audit.ts'],false],
 ['calibration',['bun','scripts/eval/attribution/calibrate.ts'],false],
 ['reference-examples',['bun','scripts/eval/attribution/reference-examples.mjs'],false],
 ['stability',['bun','scripts/eval/attribution/stability.ts'],false],
 ['repair-qualification',['bun','scripts/eval/attribution/repair-qualification.ts'],false],
 ['historical',['bun','scripts/eval/attribution/replay.ts'],false],
 ['interaction',['bun','scripts/eval/attribution/interaction.ts'],true],
 ['transport',['bun','scripts/eval/attribution/transport-smoke.ts'],true],
 ['protocol',['bun','scripts/eval/attribution/protocol-smoke.ts'],true],
 ['review',['bun','scripts/eval/attribution/smoke.ts'],true],
 ['pipeline',['bun','scripts/eval/attribution/pipeline.ts','--mock'],false],
 ['fault',['bun','scripts/eval/attribution/fault-check.ts'],false],
 ['dependencies-after',['bun','scripts/eval/attribution/dependencies.ts'],true],
] as const;
save(join(directory,'declared.json'),steps);
try{for(const [id,args,lock]of steps){unchanged(provenance);if(Date.now()>=limit)throw Error('资格窗口耗尽');const run=()=>command([...args],undefined,true,Math.min(45*60000,limit-Date.now()));const r=lock?await withResources('offline:'+id,run):await run();save(join(directory,id+'.json'),r);const passed=r.exitCode===0&&!r.timedOut;results.push({id,passed,exitCode:r.exitCode,timedOut:r.timedOut,durationMs:r.durationMs});console.log(JSON.stringify(results.at(-1)));if(!passed)throw Error('离线门槛失败:'+id)}unchanged(provenance);complete=true}finally{save(join(STUDY,'offline-gates.json'),{complete,image:IMAGE,sourceHash:p.sourceHash,executionProfileHash:p.executionProfileHash,graderRevision:p.graderRevision,directory,results})}
