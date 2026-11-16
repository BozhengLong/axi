import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const [outputArg,manifestArg]=process.argv.slice(2);if(!outputArg||!manifestArg)throw Error('需要证据目录和对应源码清单');
const output=resolve(outputArg),manifest=JSON.parse(readFileSync(manifestArg,'utf8')),results=JSON.parse(readFileSync(join(output,'results.json'),'utf8'));
assert.equal(results.plan.sourceHash,manifest.sourceHash);assert.equal(results.plan.candidate,manifest.commit);assert.equal(results.rows.length,30);assert.equal(results.plan.repeats,5);
const seen=new Set<string>();
for(const row of results.rows){
 assert(!seen.has(row.id));seen.add(row.id);assert(row.passed&&row.traceComplete&&!row.error);
 const dir=join(output,row.id),full=JSON.parse(readFileSync(join(dir,'result.json'),'utf8')),http=JSON.parse(readFileSync(join(dir,'http.json'),'utf8'));
 assert.deepEqual(full.after,full.afterReplace);assert.equal(full.after.head,full.initial.head);assert.equal(full.after.index,full.initial.index);assert.equal(full.exitCode,0);
 const logs=join(dir,'native-axi/logs'),names=readdirSync(logs).filter(x=>x.endsWith('.jsonl'));assert.equal(names.length,1);
 const events=readFileSync(join(logs,names[0]!),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.deepEqual(events.filter(x=>x.kind==='request').map(x=>x.data.body),http.map((x:any)=>x.request));
 const recovered=full.variant==='recover-target',prepared=events.filter(x=>x.kind==='read_identity_prepared'),permissions=events.filter(x=>x.kind==='permission');assert.equal(http.length,recovered?4:2);assert.equal(prepared.length,recovered?2:1);assert.equal(permissions.length,prepared.length);
 for(const [i,p]of prepared.entries()){assert(events.indexOf(p)<events.indexOf(permissions[i]));assert.equal(permissions[i].data.allowed,true);assert.equal(permissions[i].data.mode,'strict');assert.equal(permissions[i].data.toolUseId,p.data.toolUseId)}
 const toolResults=events.filter(x=>x.kind==='tool_result');assert.equal(toolResults.length,prepared.length);assert.deepEqual(JSON.parse(toolResults[0].data.content),full.result);
 if(recovered){assert.equal(full.result.code,'path_changed');assert.equal(toolResults[0].data.is_error,true);assert(!JSON.stringify(full.result).includes('MUST_NOT_READ'));assert(!readFileSync(join(dir,'first-terminal.raw'),'utf8').includes('MUST_NOT_READ'));assert.notEqual(prepared[0].data.bindingId,prepared[1].data.bindingId);assert.notEqual(prepared[0].data.digest,prepared[1].data.digest);assert.deepEqual(JSON.parse(toolResults[1].data.content),full.fresh);assert.equal(toolResults[1].data.is_error,false);}
 else assert.equal(toolResults[0].data.is_error,false);
}
for(const x of results.plan.variants)for(let i=1;i<=5;i++)assert(seen.has(`${x.tool}-${x.variant}-${i}`));
const audit={sourceHash:manifest.sourceHash,rows:seen.size,qualified:true,scope:'合法内容更新/目录增项及新的strict授权恢复；首个失败调用与后续成功调用分别审计'};writeFileSync(join(output,'audit.json'),JSON.stringify(audit,null,2));console.log(JSON.stringify(audit));
