import {current,save} from "../core.ts";
import {complexTasks,reference,mutant} from "./tasks.ts";
import {gradeComplex,pack} from "./grade.ts";
import {fingerprint} from "./fingerprint.ts";
const b=current(),prefix=`cal-${Date.now().toString(36)}`;const results:any[]=[];
for(const task of complexTasks()){
 const variants=[{name:"seed",files:task.files},{name:"reference",files:reference(task)},{name:"mutant-atomicity",files:mutant(task,0)},{name:"mutant-compatibility",files:mutant(task,1)}];
 for(const variant of variants){const id=`${prefix}-${task.id}-${variant.name}`;console.log(JSON.stringify({event:"calibrate",task:task.id,variant:variant.name}));
 const grade=await gradeComplex(b,id,task,{status:"completed"},pack(variant.files));
 const healthy=grade.checks.filter(c=>["严格类型检查","原测试与新增回归","独立验收程序完成"].includes(c.name)).every(c=>c.pass);
 const accepted=variant.name==="reference"?grade.pass:healthy&&!grade.pass&&!grade.checks.some(c=>c.name==="验收环境完成"&&!c.pass);
 results.push({task:task.id,variant:variant.name,id,accepted,grade});save(`${b.directory}/complex-calibration.json`,{pass:false,complete:false,results});
 console.log(JSON.stringify({event:"calibrated",task:task.id,variant:variant.name,accepted,failed:grade.checks.filter(c=>!c.pass).map(c=>c.name)}));
 }
}
const pass=results.every(r=>r.accepted);save(`${b.directory}/complex-calibration.json`,{pass,complete:true,...fingerprint(),time:new Date().toISOString(),image:b.image,results});if(!pass)process.exitCode=1;
