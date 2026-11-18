// 用真实工具记录构造两个配对输入。评分表、参考答案和版本标签都不放入请求。
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash,randomBytes,randomInt} from "node:crypto";
import {execFileSync} from "node:child_process";
import assert from "node:assert/strict";
process.umask(0o077);
const [studyArg,priorArg,productArg,formalArg]=process.argv.slice(2);
assert(studyArg && priorArg && productArg && formalArg);
const [study,prior,product,formal]=[studyArg,priorArg,productArg,formalArg].map(x=>resolve(x)) as [string,string,string,string];
const read=(p:string)=>JSON.parse(readFileSync(p,"utf8"));
const save=(p:string,x:unknown)=>writeFileSync(p,JSON.stringify(x,null,2)+"\n",{flag:"wx"});
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const git=(...args:string[])=>execFileSync("git",args,{cwd:product,encoding:"utf8"}).trim();
const {CheckAttempts}=await import(pathToFileURL(join(product,"src/tools/check-attempts.ts")).href);
const {reviewPrompt}=await import(pathToFileURL(join(product,"src/agent/review.ts")).href);
const priorManifest=read(join(prior,"manifest.json")), preflight=read(join(prior,"report-only-inputs/preflight.json"));
const priorPrompts=read(join(prior,"prompts.json"));assert.equal(sha(join(prior,"prompts.json")),priorManifest.files["prompts.json"]);
assert.equal(reviewPrompt(),priorPrompts.experiment);assert.equal(git("status","--porcelain"),"");
const base=priorManifest.experiment,exp=git("rev-parse","HEAD");assert.equal(git("rev-parse","HEAD^"),base);
const productDiff=git("diff","--name-only",base,exp,"--","src").split("\n").sort();
assert.deepEqual(productDiff,["src/agent/loop.ts","src/tools/check-attempts.ts","src/tools/common.ts","src/tools/registry.ts"]);
const cases=preflight.rows.map((x:any)=>x.case) as string[],hashes:Record<string,string>={};
for(const dir of ["inputs","inputs-experiment","observations"])mkdirSync(join(study,dir));
const freeze=(name:string,x:unknown)=>{save(join(study,name),x);hashes[name]=sha(join(study,name));};
assert.equal(cases.length,6);
for(const row of preflight.rows){
  const path=join(prior,"report-only-inputs",row.case+".json");assert.equal(sha(path),row.revisedSha256);
  const control=read(path);
  const review=control.messages.filter((m:any)=>m.role==="user"&&m.content===priorPrompts.baseline);assert.equal(review.length,1);
  review[0].content=reviewPrompt();freeze("inputs/"+row.case+".json",control);
  const body=structuredClone(control);const calls=new Map<string,any>();const book=new CheckAttempts();const records=[];
  for(const msg of body.messages){
    for(const part of Array.isArray(msg.content)?msg.content:[]){
      if(part.type==="tool_use" && part.name==="bash")calls.set(part.id,part.input);
      if(part.type!=="tool_result"||!calls.has(part.tool_use_id))continue;
      assert.equal(typeof part.content,"string");const head=/^退出码：(\d+)\n/.exec(part.content);
      // 本实验固定历史里的 bash 均正常结束。首行是工具生成的外层退出记录。
      assert(head,"无可绑定的工具首行，应单独核对，不推断状态");
      const cmd=calls.get(part.tool_use_id).command;
      const receipt=book.record(part.tool_use_id,cmd,part.content,Number(head[1]),"completed");
      records.push(receipt);part.content+=book.render();
    }
  }
  if(row.case==="history"){
    const report=read(join(formal,"final-audit-r3/release-report.json"));
    const old=read(join(formal,"runs/C7-L-a1/execution-result.json"));
    assert(report.attempts.some((r:any)=>r.slot==="C7-L-a1" && r.classification==="N"));
    const ids=records.filter(x=>x.reported.some((s:any)=>s.value===127));
    assert.equal(ids.length,2);
    assert(ids.some(x=>x.command.includes("npx jest")&&x.shellExit===0));
    assert(ids.some(x=>x.command.includes("./node_modules/.bin/jest")&&x.shellExit===0));
    assert(records.some(x=>x.reported.some((r:any)=>r.label==="baseline_jest"&&r.value===1)));
    assert(records.some(x=>x.reported.some((r:any)=>r.label==="test"&&r.value===0)));
    assert(!JSON.stringify(body.messages).includes(old.execution.turns.at(-1)));
  }
  if(row.case==="clean"||row.case==="unobserved")assert(records.every(x=>!x.reported.length));
  freeze("observations/"+row.case+".json",records);freeze("inputs-experiment/"+row.case+".json",body);
}
assert.equal(sha(join(prior,"rubric.json")),priorManifest.files["rubric.json"]);freeze("rubric.json",read(join(prior,"rubric.json")));
freeze("prompts.json",{baseline:reviewPrompt(),experiment:reviewPrompt()});
for(let i=cases.length-1;i>0;i--){let j=randomInt(i+1);[cases[i],cases[j]]=[cases[j]!,cases[i]!];}
const order=[];
for(const repeat of [1,2]){
  for(const name of repeat===1?cases:[...cases].reverse()){
    const arms=(cases.indexOf(name)+repeat)%2===1?["baseline","experiment"]:["experiment","baseline"];
    for(const arm of arms)order.push({case:name,arm,repeat,blind:randomBytes(8).toString("hex")});
  }
}
freeze("key.json",{order});save(join(study,"manifest.json"),{schema:"check-attempts-v1",at:new Date().toISOString(),base,experiment:exp,previous:priorManifest.base,files:hashes,reportingModel:"claude-opus-5-5",effort:"medium",sourceRevision:sha(join(prior,"report-only-inputs/preflight.json")),scope:"一次独立C7-L试报及24份首次盲评回答；仅加入通用的工具尝试记录。"});
console.log("frozen 6 pairs, 24 blind IDs and C7-L witness checks");
