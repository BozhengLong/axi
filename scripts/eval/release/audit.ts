import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// 审计原生CLI证据，不把驱动进程退出0解释为产品通过。
const root=resolve(process.argv[2] ?? '');
if(!process.argv[2]) throw Error('需要本轮私有证据目录');
const summary:any[]=[];
for(const platform of ['macos','linux']) {
 const dir=join(root,`${platform}-cli-identity`),results=JSON.parse(readFileSync(join(dir,'results.json'),'utf8'));
 assert.equal(results.plan.repeats,5);assert.equal(results.rows.length,55);
 const ids=new Set<string>();
 for(const row of results.rows) {
  assert(!ids.has(row.id));ids.add(row.id);
  const entry=join(dir,row.id),full=JSON.parse(readFileSync(join(entry,'result.json'),'utf8'));
  assert.equal(full.exitCode,0);assert.equal(full.requests,2);assert.equal(full.error,undefined);assert.equal(full.unchanged,true);
  const http=JSON.parse(readFileSync(join(entry,'http.json'),'utf8'));
  const logsDir=join(entry,'native-axi/logs'),files=readdirSync(logsDir).filter(x=>x.endsWith('.jsonl'));assert.equal(files.length,1);
  const events=readFileSync(join(logsDir,files[0]!),'utf8').trim().split('\n').map(x=>JSON.parse(x));
  const requests=events.filter(x=>x.kind==='request');assert.equal(requests.length,2);
  requests.forEach((event,i)=>assert.deepEqual(event.data.body,http[i].request));
  const start=events.find(x=>x.kind==='task_start');assert.equal(start.data.permissionMode,'strict');assert.equal(start.data.reviewMode,'auto');
  const permission=events.filter(x=>x.kind==='permission');assert.equal(permission.length,1);assert.equal(permission[0].data.source,'user');assert.equal(permission[0].data.allowed,full.variant!=='deny-replaced');
  const outcome=events.filter(x=>x.kind==='tool_result');assert.equal(outcome.length,1);assert.deepEqual(JSON.parse(outcome[0].data.content),full.result);
  assert.equal(events.filter(x=>x.kind==='task_end').length,1);
  assert(events.some(x=>x.kind==='sse'));assert(readFileSync(join(entry,'terminal.raw'),'utf8').includes('执行这次读取？'));
  const expected=full.variant==='unchanged'? !full.rejected : full.identityChanged && full.rejected && !full.leaked;
  assert.equal(full.passed,expected);assert.equal(row.passed,expected);
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
const result={candidate:'0f4a2c4df87b01d6290ff81dfea2541a5169e2ae',auditedAt:new Date().toISOString(),summary,decision:summary.some(x=>x.failed>0)?'NO-GO':'P02-PASS',basis:'P-02 isolated identity checks; this does not qualify the other engineering gates',liveCliStarts:0,generationRequests:0};
writeFileSync(join(root,'cli-trace-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
