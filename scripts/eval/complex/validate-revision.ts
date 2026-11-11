import {readFileSync} from "node:fs";
import {join} from "node:path";
import {current,save,STORE,type Batch} from "../core.ts";
import {complexTasks,reference,mutant} from "./tasks.ts";
import {gradeComplex,pack} from "./grade.ts";
import {fingerprint} from "./fingerprint.ts";
// 离线验证新增边界；不请求模型，不修改既有成绩或归档。
const source=current(),id=`offline-v3-${new Date().toISOString().replace(/[^0-9]/g,"").slice(0,14)}`;
const b:Batch={id,directory:join(STORE,id),relay:"offline",admin:"unused",endpoint:"offline",image:source.image,created:new Date().toISOString()};
const frozen=fingerprint(),calibration:any[]=[];
for(const task of complexTasks())for(const [variant,files] of [["seed",task.files],["reference",reference(task)],["mutant-atomicity",mutant(task,0)],["mutant-compatibility",mutant(task,1)]] as const){
 const verdict=await gradeComplex(b,`${task.id}-${variant}`,task,{status:"completed"},pack(files));
 const healthy=verdict.checks.filter(c=>["严格类型检查","原测试与新增回归","独立验收程序完成"].includes(c.name)).every(c=>c.pass);
 const accepted=variant==="reference"?verdict.pass:healthy&&!verdict.pass;
 calibration.push({task:task.id,variant,accepted,...verdict});console.log(JSON.stringify({event:"calibration-v3",task:task.id,variant,accepted,failed:verdict.checks.filter(c=>!c.pass).map(c=>c.name)}));
}
if(!calibration.every(c=>c.accepted))throw Error("v3 参考实现或错误变体校准未通过");
const study=join(STORE,"complex-20261111"),rows=JSON.parse(readFileSync(join(study,"results.json"),"utf8")).filter((r:any)=>r.task==="C1");
if(rows.length!==6)throw Error("需要六份已冻结 C1 产物");
const task=complexTasks().find(t=>t.id==="C1")!,results=[];
for(const row of rows){const final=JSON.parse(readFileSync(join(STORE,row.sourceBatch,row.id,"final-files.json"),"utf8"));const grade=await gradeComplex(b,`saved-${row.agent}-r${row.repeat}`,task,{status:row.status},final);const result={sourceBatch:row.sourceBatch,sourceRun:row.id,agent:row.agent,repeat:row.repeat,originalPass:row.pass,...grade};results.push(result);console.log(JSON.stringify({event:"saved-artifact-v3",agent:row.agent,repeat:row.repeat,pass:grade.pass,failed:grade.checks.filter(c=>!c.pass).map(c=>c.name)}));}
if(fingerprint().sourceHash!==frozen.sourceHash)throw Error("离线验证期间源码改变");
const report={id,created:new Date().toISOString(),image:b.image,scope:"事后扩展验收，未重新运行模型，未覆盖正式 v2 成绩",...frozen,calibration,results};save(join(b.directory,"report.json"),report);save(join(study,"supplemental-v3.json"),report);console.log(JSON.stringify({event:"offline-v3-complete",id,axi:results.filter(r=>r.agent==="axi"&&r.pass).length,claude:results.filter(r=>r.agent==="claude"&&r.pass).length}));
