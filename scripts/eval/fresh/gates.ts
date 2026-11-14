import {join} from 'node:path';
import {FRESH,STUDY,read} from './settings.ts';
import {profile} from './profile.ts';
export function gates(){
 const p=profile(),frozen=read(join(FRESH,'freeze.json')),offline=read(join(FRESH,'offline-gates.json'));
 if(frozen.sourceHash!==p.sourceHash||frozen.executionProfileHash!==p.executionProfileHash||frozen.oracleHash!==p.oracleHash||frozen.graderRevision!==p.graderRevision||frozen.remoteVerified!==true)throw Error('新题正式冻结或推送核对未完成');
 if(!offline.complete||offline.sourceHash!==p.sourceHash||offline.executionProfileHash!==p.executionProfileHash)throw Error('新设施当前版本离线门槛缺失');
 const cal=read(join(FRESH,'calibration-latest.json')),pipe=read(join(FRESH,'pipeline-latest.json')),fault=read(join(FRESH,'grader-fault-check.json'));
 if(!cal.complete||cal.sourceHash!==p.sourceHash||cal.rows.length!==21||cal.rows.some((r:any)=>!r.passed)||!pipe.complete||pipe.sourceHash!==p.sourceHash||pipe.results.length!==6||pipe.results.some((r:any)=>!r.passed)||!fault.complete||fault.sourceHash!==p.sourceHash)throw Error('校准、完整模拟或评分故障检查缺失');
 const pre=read(join(STUDY,'preflight-latest.json'));if(!pre.complete||pre.image!==p.execution.image)throw Error('冻结镜像真实接入前置缺失');
 return {freeze:frozen,offline,calibration:cal.directory,pipeline:pipe.directory,preflight:pre.directory};
}
