import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {splitHashes} from '../scripts/eval/review/profile.ts';
test('新研究四次开发额度、关闭决定和旧计划隔离',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'axi-review-budget-'));try{
  const now=Date.now(),auth={startedAt:new Date(now).toISOString(),deadline:new Date(now+18*3600000).toISOString(),plan:'docs/11-v1-delivery-review-plan.md',confirmedBy:'user',maxStarts:33,maxDevelopment:4,maxC7:2,maxFormal:21,maxProbes:6,maxUpstreamRecovery:1,maxGradeRecovery:1,reportReserveMinutes:30,taskSeconds:1800,gradeSeconds:900,taskRequests:50,workRequests:40,reviewRequests:10,probeSeconds:120,probeRequests:12};
  writeFileSync(join(dir,'authorization.json'),JSON.stringify(auth));
  const script='import{claimStart}from '+JSON.stringify(resolve('scripts/eval/review/config.ts'))+';claimStart(process.argv[1],"development",{});';
  async function claim(id:string){const p=Bun.spawn(['bun','-e',script,id],{env:{...process.env,AXI_REVIEW_STUDY:dir,AXI_V1_STUDY:dir,AXI_EVAL_IMAGE:'sha256:test',AXI_V1_IMAGE:'sha256:test',AXI_V1_NODE_PROFILE:'node22'},stdout:'pipe',stderr:'pipe'});return {code:await p.exited,error:await new Response(p.stderr).text()}}
  for(let i=0;i<4;i++)expect((await claim('run'+i)).code).toBe(0);
  expect((await claim('run4')).error).toContain('额度');
  writeFileSync(join(dir,'closure.json'),'{}');expect((await claim('closed')).error).toContain('关闭');
  rmSync(join(dir,'closure.json'));writeFileSync(join(dir,'authorization.json'),JSON.stringify({...auth,plan:'docs/10-v1-release-candidate-plan.md'}));expect((await claim('old')).error).toContain('授权');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('复核运行、检查点和预算逻辑属于执行身份；评分器仍独立版本化',()=>{
 const a=splitHashes({'src/agent/review.ts':'a','scripts/eval/v1/job.ts':'b','scripts/eval/review/run.ts':'c','scripts/eval/review/grade-one.ts':'d','evals/v1-review-development/async-boundaries.mjs.fixture':'e'});
 expect(Object.keys(a.execution)).toHaveLength(3);expect(Object.keys(a.grader)).toHaveLength(1);expect(Object.keys(a.oracle)).toHaveLength(1);
});
