import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
test('发布候选台账跨进程拒绝重用ID、超额、过期及错误授权',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'axi-rc-budget-'));
 try{
  const started=Date.now(),a={startedAt:new Date(started).toISOString(),deadline:new Date(started+18*3600000).toISOString(),plan:'docs/10-v1-release-candidate-plan.md',confirmedBy:'user',maxStarts:31,maxPilots:2,maxC7:2,maxFormal:21,maxProbes:6,taskSeconds:1800,gradeSeconds:900,taskRequests:50,probeSeconds:120,probeRequests:12};
  writeFileSync(join(dir,'authorization.json'),JSON.stringify(a));
  const script='import{claimStart}from '+JSON.stringify(resolve('scripts/eval/rc/config.ts'))+';claimStart(process.argv[1],"pilot",{});';
  async function claim(id:string){const p=Bun.spawn(['bun','-e',script,id],{env:{...process.env,AXI_RC_STUDY:dir,AXI_V1_STUDY:dir,AXI_EVAL_IMAGE:'sha256:test',AXI_V1_IMAGE:'sha256:test',AXI_V1_NODE_PROFILE:'node22'},stdout:'pipe',stderr:'pipe'});return {code:await p.exited,error:await new Response(p.stderr).text()}}
  expect((await claim('one')).code).toBe(0);expect((await claim('one')).code).not.toBe(0);expect((await claim('two')).code).toBe(0);expect((await claim('three')).error).toContain('额度');
  writeFileSync(join(dir,'authorization.json'),JSON.stringify({...a,startedAt:new Date(started-19*3600000).toISOString(),deadline:new Date(started-3600000).toISOString()}));expect((await claim('expired')).error).toContain('截止');
  writeFileSync(join(dir,'authorization.json'),JSON.stringify({...a,maxStarts:32}));expect((await claim('unauthorized')).error).toContain('授权');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
