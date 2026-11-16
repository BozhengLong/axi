import {copyFileSync,existsSync,readFileSync}from'node:fs';
import {join,resolve}from'node:path';
import assert from'node:assert/strict';
import {control,docker,save,type Batch,type Runtime}from'../core.ts';
import {finalizeTrace}from'../trace.ts';
import {sha}from'./source.ts';

// 转发器仍存活时，trace-manifest只能算临时清单。停止最后一个写入者再封存。
// 未完成请求保留为未完成，不等待迟到答案，也不将它补算为产品交付。
export async function sealBatchTraces(batch:Batch,runtimes:Pick<Runtime,'id'|'directory'>[]){
 const states=[];
 for(const r of runtimes){const state=await control(batch,'state',{id:r.id});assert(state.revoked);states.push({id:r.id,activeRequests:state.activeRequests,requests:state.budget.generationRequests})}
 save(join(batch.directory,'relay-before-close.json'),{at:new Date().toISOString(),states});
 const stopped=await docker(['rm','-f',batch.relay]);assert.equal(stopped.exitCode,0);
 const check=await docker(['ps','-a','--filter',`name=^/${batch.relay}$`,'--format','{{.Names}}']);assert.equal(check.stdout.trim(),'');
 save(join(batch.directory,'relay-closed.json'),{at:new Date().toISOString(),name:batch.relay,exitCode:stopped.exitCode,remaining:[]});
 const seals=[];
 for(const r of runtimes){const prior=join(r.directory,'trace-manifest.json'),provisional=join(r.directory,'trace-provisional.json');if(existsSync(prior)){assert(!existsSync(provisional));copyFileSync(prior,provisional)}
  save(join(r.directory,'writers-closed.json'),{relay:batch.relay,closedRecord:'../relay-closed.json',product:'frozen and removed by destroyRuntime',unfinishedRequests:states.find(s=>s.id===r.id)!.activeRequests});
  const manifest=finalizeTrace(batch,r as Runtime);assert.equal(manifest.status,'complete_observable');
  for(const f of manifest.files){const bytes=readFileSync(resolve(r.directory,f.path));assert.equal(bytes.length,f.bytes);assert.equal(sha(bytes),f.sha256)}
  seals.push({id:r.id,files:manifest.files.length,manifestHash:sha(readFileSync(prior))});
 }
 save(join(batch.directory,'sealed-traces.json'),{at:new Date().toISOString(),seals});return seals;
}
