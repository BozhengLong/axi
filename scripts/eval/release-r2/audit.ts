import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// 审计原生CLI证据，不把驱动进程退出0解释为产品通过。
const root=resolve(process.argv[2] ?? '');
const prefix=process.argv[3]??'dev';
if(!process.argv[2]) throw Error('需要本轮私有证据目录');
if(!['old','dev','c2'].includes(prefix)) throw Error('未知证据标签');
const manifest=process.argv[4]?JSON.parse(readFileSync(process.argv[4],'utf8')):undefined;
if(prefix==='c2' && manifest?.kind!=='candidate') throw Error('正式审计需要候选清单');
const summary:any[]=[];
for(const platform of ['macos','linux']) {
 const dir=join(root,prefix==='old'?`old-${platform}-cli`:prefix==='c2'?`c2-${platform}-cli`:`dev-${platform}-cli-1`),results=JSON.parse(readFileSync(join(dir,'results.json'),'utf8'));
 if(manifest){assert.equal(results.plan.sourceHash,manifest.sourceHash);assert.equal(results.plan.candidate,manifest.commit);assert.equal(results.plan.sourceKind,manifest.kind)}
 assert.equal(results.plan.repeats,5);assert.equal(results.rows.length,55);assert.equal(results.passed,results.rows.filter((x:any)=>x.passed).length);assert.equal(results.failed,results.rows.filter((x:any)=>!x.passed).length);
 const ids=new Set<string>();
 for(const row of results.rows) {
  assert(!ids.has(row.id));ids.add(row.id);
  const entry=join(dir,row.id),full=JSON.parse(readFileSync(join(entry,'result.json'),'utf8'));
  assert.equal(full.exitCode,0);assert.equal(full.requests,2);assert.equal(full.error,undefined);assert.equal(full.unchanged,true);assert.deepEqual(full.after,full.afterReplace);assert.equal(full.after.head,full.initial.head);assert.equal(full.after.index,full.initial.index);
  const http=JSON.parse(readFileSync(join(entry,'http.json'),'utf8'));
  const logsDir=join(entry,'native-axi/logs'),files=readdirSync(logsDir).filter(x=>x.endsWith('.jsonl'));assert.equal(files.length,1);
  const events=readFileSync(join(logsDir,files[0]!),'utf8').trim().split('\n').map(x=>JSON.parse(x));
  const requests=events.filter(x=>x.kind==='request');assert.equal(requests.length,2);
  requests.forEach((event,i)=>assert.deepEqual(event.data.body,http[i].request));
  const start=events.find(x=>x.kind==='task_start');assert.equal(start.data.permissionMode,'strict');assert.equal(start.data.reviewMode,'auto');
  const permission=events.filter(x=>x.kind==='permission');assert.equal(permission.length,1);assert.equal(permission[0].data.source,'user');assert.equal(permission[0].data.allowed,full.variant!=='deny-replaced');
  const outcome=events.filter(x=>x.kind==='tool_result');assert.equal(outcome.length,1);assert.equal(full.rejected,outcome[0].data.is_error===true);assert.deepEqual(JSON.parse(outcome[0].data.content),full.result);
  assert.equal(events.filter(x=>x.kind==='task_end').length,1);
  assert(events.some(x=>x.kind==='sse'));assert(readFileSync(join(entry,'terminal.raw'),'utf8').includes('执行这次读取？'));
  const expected=full.variant==='unchanged'? !full.rejected : full.identityChanged && full.rejected && !full.leaked;
  assert.equal(full.passed,expected);assert.equal(row.passed,expected);
  assert.equal(full.traceComplete,true);
  if(results.plan.sourceKind!=='historical-control'){
   const prepared=events.filter(x=>x.kind==='read_identity_prepared');assert.equal(prepared.length,1);assert(events.indexOf(prepared[0])<events.indexOf(permission[0]));
   const checks=events.filter(x=>x.kind==='read_identity_check');checks.forEach(x=>{assert.equal(x.data.bindingId,prepared[0].data.bindingId);assert.equal(x.data.digest,prepared[0].data.digest);assert.equal(x.data.toolUseId,permission[0].data.toolUseId)});
   if(full.variant==='deny-replaced')assert.equal(checks.length,0);else assert(checks.length>=1);
   assert(!JSON.stringify(checks).includes('MUST_NOT_READ'));
  }
  if(full.variant==='unchanged') {
   if(full.tool==='read') assert.equal(full.result.content,'original needle\n');
   else if(full.tool==='glob') assert.deepEqual(full.result.results,['sub/a.txt']);
   else assert.deepEqual(full.result.results,[{path:'sub/a.txt',line:1,content:'original needle\n'}]);
  }
  if(full.variant==='deny-replaced') assert.equal(full.result.code,'user_denied');
  if(full.variant==='symlink-target') assert.equal(full.result.code,'symlink');
 }
 for(const variant of results.plan.variants) for(let repeat=1;repeat<=5;repeat++) assert(ids.has(`${variant.tool}-${variant.variant}-${repeat}`));
 summary.push({platform,cliRuns:55,httpRequests:110,passed:results.passed,failed:results.failed,nativeAndRelayMatch:true,filesAndGitPreserved:true});
}
const result={label:prefix,sourceHash:manifest?.sourceHash,auditedAt:new Date().toISOString(),summary,decision:summary.some(x=>x.failed>0)?'B01-FAIL':'B01-PASS',basis:'P-02 isolated identity checks; this does not qualify the other engineering gates',liveCliStarts:0,generationRequests:0};
writeFileSync(join(root,`${prefix}-cli-trace-audit.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));

process.exitCode=summary.some(x=>x.failed>0)?1:0;
