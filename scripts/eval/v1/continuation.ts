import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {STUDY,IMAGE,type TaskId} from './settings.ts';
import {taskFiles,snapshotHash,contents} from './tasks.ts';

const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export function continuation(directory:string,hashes:Record<string,string>,runtimeHash:string,inputs:Record<string,string>){
 const old=read(join(directory,'manifest.json')),stop=read(join(directory,'controlled-stop.json'));
 const claim=read(join(STUDY,'formal.claim')),attempts=read(join(directory,'attempts.json')),rows=read(join(directory,'stopped-results.json'));
 const expected=['formal-C7-L-r1-new','formal-C7-O-r1-new','formal-V1-A-r1-old','formal-V1-A-r1-new'];
 if(stop.stopReason!=='documented_test_command_mismatch'||stop.modelInterrupted!==false||stop.starts!==4||old.image!==IMAGE||old.runtimeHash!==runtimeHash||old.deadline!==claim.deadline)throw Error('不是允许修复的公开命令设施事件');
 if(attempts.length!==4||rows.length!==4||expected.some((id,i)=>attempts[i]?.id!==id||rows[i]?.id!==id||rows[i]?.status!=='completed'))throw Error('原样本未完整留证或启动范围改变');
 // 仅允许改公开命令、它的校准，以及本次重新冻结的调度。产品、题面、参考和判定规则不能改变。
 const allowed=new Set(['scripts/eval/v1/prepare.ts','scripts/eval/v1/calibrate.ts','scripts/eval/v1/run.ts','scripts/eval/v1/continuation.ts','evals/specs/v1-holdout-v1/README.md']);
 for(const path of new Set([...Object.keys(old.hashes),...Object.keys(hashes)]))if(old.hashes[path]!==hashes[path]&&!allowed.has(path))throw Error('设施修订超出已记录范围：'+path);
 for(const task of ['C7-L','C7-O'] as const)if(inputs[task]!==old.inputs[task])throw Error('已知回归输入改变');
 for(const task of ['V1-A','V1-B'] as const){
  const previous=read(join(STUDY,'tasks',task.slice(-1),'input-r2.json')),current=taskFiles(task);
  if(snapshotHash(previous)!==old.inputs[task])throw Error('原输入归档不符');
  for(const path of new Set([...Object.keys(previous),...Object.keys(current)]))if(path!=='eval/environment.md'&&JSON.stringify(previous[path])!==JSON.stringify(current[path]))throw Error('题目输入不仅修改公开命令：'+path);
  const before=contents(previous['eval/environment.md']),after=contents(current['eval/environment.md']!);
  const expected=before.replace('node node_modules/ava/entrypoints/cli.mjs --config eval/ava.config.mjs`','node node_modules/ava/entrypoints/cli.mjs --config eval/ava.config.mjs '+(task==='V1-A'?'test.js':'test/index.js')+'`').replace('node node_modules/xo/cli.js','./node_modules/.bin/xo');
  if(expected!==after)throw Error('公开命令修订超出已复现修复');
 }
 const start=Date.parse(claim.start),deadline=Date.parse(claim.deadline);
 if(!Number.isFinite(start)||deadline-start!==18*3600_000)throw Error('原截止不合法');
 return {directory,starts:4,start,deadline,known:rows.slice(0,2).map((r:any)=>({...r,originDirectory:directory})),excluded:rows.slice(2).map((r:any)=>r.id),recoveryConsumed:true};
}
