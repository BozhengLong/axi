import {join,dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import {save} from '../core.ts';
import {taskFiles,reference} from '../v1/tasks.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {extraChecks} from './quality.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
const a=authorization(),directory=join(STUDY,'quality-calibration-'+Date.now()),rows:any[]=[];
const historical=read(join(STUDY,'input-provenance.json')).sourceStudy,state=read(join(historical,'state.json'));
for(const task of ['V1-A','V1-B']as const){const r=await extraChecks(task,taskFiles(task),reference(task),join(directory,task+'-reference'),a.workDeadline);rows.push({id:task+'-reference',passed:r.passed,checks:r.checks})}
for(const [id,expected]of [['formal-V1-B-r1-new','OVERFLOW_ISOLATION'],['formal-V1-B-r1-old','README_JS:']]as const){
 const x=state.executions.find((x:any)=>x.id===id);if(!x)throw Error('缺少已知产物');
 const r=await extraChecks('V1-B',read(join(x.runDirectory,'initial-files.json')),read(join(x.runDirectory,'final-files.json')),join(directory,id),a.workDeadline);
 rows.push({id,artifactHash:x.artifactHash,passed:!r.passed&&r.checks.some((c:any)=>c.id.startsWith(expected)&&!c.passed),checks:r.checks});
}
// 对报告问题保留完整命令结果与时间顺序。这里只校准证据提取，不自动理解自然语言。
const x=state.executions.find((x:any)=>x.id==='formal-V1-A-r1-old'),events=readFileSync(join(dirname(x.runDirectory),'relay',x.id+'.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
const calls=new Map<string,any>(),results=new Map<string,any>();
for(const e of events)if(e.kind==='request')for(const m of e.data.body?.messages??[])for(const b of Array.isArray(m.content)?m.content:[]){if(b.type==='tool_use'&&!calls.has(b.id))calls.set(b.id,{...b,observedAt:e.time});if(b.type==='tool_result')results.set(b.tool_use_id,b)}
const ordered=[...calls.values()],lastXO=ordered.findIndex(t=>t.id==='toolu_01Y5uuCMdKYG4kAKk5YNTybs'),lastEdit=ordered.findIndex(t=>t.id==='toolu_01C6k6gibhWPnfMbMAhyAVmJ');
save(join(directory,'known-report-evidence.json'),{artifactHash:x.artifactHash,report:read(join(x.runDirectory,'result.json')).turns,commands:ordered.map(t=>({...t,result:results.get(t.id)})),assessment:'最后XO仍有错误，随后改动没有重跑XO，报告不能称其状态已验证'});
rows.push({id:'known-report-evidence',passed:lastXO>=0&&lastEdit>lastXO&&String(JSON.stringify(results.get(ordered[lastXO]!.id))).includes('1 error')&&!ordered.slice(lastEdit).some(t=>/\bxo\b/.test(t.input.command??'')),artifactHash:x.artifactHash});
const report={complete:rows.every(r=>r.passed),image:IMAGE,sourceHash:fingerprint().sourceHash,directory,results:rows};save(join(STUDY,'quality-calibration-latest.json'),report);console.log(JSON.stringify({complete:report.complete,results:rows.map(({id,passed})=>({id,passed}))}));if(!report.complete)process.exitCode=1;
