import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
test('重入研究拒绝旧授权、重复启动、超额、停止及截止外新任务',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'axi-reentry-budget-'));
 try{
  const now=Date.now(),a={plan:'docs/13-v1-reentrancy-qualification-plan.md',confirmedBy:'user',startedAt:new Date(now).toISOString(),deadline:new Date(now+18*3600000).toISOString(),maxStarts:34,maxDevelopment:4,maxC7:2,maxFormal:21,maxProbes:7,maxUpstreamRecovery:1,maxGradeRecovery:1,reportReserveMinutes:30,taskSeconds:1800,gradeSeconds:900,taskRequests:50,workRequests:40,reviewRequests:10,probeSeconds:120,probeRequests:12,groupSeconds:9000,recoveryGroupSeconds:9360};
  const auth=(value:unknown)=>writeFileSync(join(directory,'authorization.json'),JSON.stringify(value));auth(a);writeFileSync(join(directory,'image.json'),JSON.stringify({image:'sha256:test'}));
  const script='import{claimStart}from '+JSON.stringify(resolve('scripts/eval/reentry/config.ts'))+';claimStart(process.argv[1],"development",{});';
  async function claim(id:string){const child=Bun.spawn(['bun','-e',script,id],{env:{...process.env,AXI_REENTRY_STUDY:directory,AXI_V1_STUDY:directory,AXI_EVAL_IMAGE:'sha256:test',AXI_V1_IMAGE:'sha256:test',AXI_V1_NODE_PROFILE:'node22'},stdout:'pipe',stderr:'pipe'});return {code:await child.exited,error:await new Response(child.stderr).text()}}
  expect((await claim('first')).code).toBe(0);expect((await claim('first')).code).not.toBe(0);
  auth({...a,plan:'docs/12-v1-trustworthy-evaluation-plan.md'});expect((await claim('old')).error).toContain('授权');auth(a);
  writeFileSync(join(directory,'stop.json'),'{}');expect((await claim('stopped')).error).toContain('停止');rmSync(join(directory,'stop.json'));
  for(let i=1;i<4;i++)expect((await claim('run'+i)).code).toBe(0);expect((await claim('fifth')).error).toContain('额度');
  writeFileSync(join(directory,'closure.json'),'{}');expect((await claim('closed')).error).toContain('关闭');rmSync(join(directory,'closure.json'));
  auth({...a,startedAt:new Date(now-18*3600000).toISOString(),deadline:new Date(now).toISOString()});expect((await claim('late')).error).toContain('工作窗口');
 }finally{rmSync(directory,{recursive:true,force:true})}
});
