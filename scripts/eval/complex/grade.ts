import {isDeepStrictEqual as equal} from "node:util";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {docker,execute,encodeFiles,save,type Batch,type Snapshot,type SeedFiles} from "../core.ts";
import type {Execution} from "../adapters.ts";
import {fixtureRoot,type ComplexTask} from "./tasks.ts";
import {replayCases} from "./replay-cases.ts";
export type Check={name:string;pass:boolean;actual?:unknown};
export function pack(files:SeedFiles):Snapshot{return Object.fromEntries(Object.entries(files).map(([p,v])=>[p,{type:"file",mode:0o644,data:Buffer.from(typeof v==="string"?new TextEncoder().encode(v):v).toString("base64")}]));}
export async function gradeComplex(batch:Batch,id:string,task:ComplexTask,execution:Pick<Execution,"status">,final:Snapshot) {
 const checks:Check[]=[];const check=(name:string,pass:boolean,actual?:unknown)=>checks.push({name,pass:!!pass,actual});
 check("产品完成任务",execution.status==="completed",execution.status);
 const protectedChanged=task.protected.filter(p=>final[p]?.type!=="file"||final[p]?.data!==pack({[p]:task.files[p]!})[p]!.data||final[p]?.mode!==0o644);
 check("保留原测试与受保护文件",protectedChanged.length===0,protectedChanged);
 check("无符号链接或特殊文件",Object.values(final).every(f=>["file","directory"].includes(f.type)));
 const name=`axi-eval-${batch.id}-verify-${id}`;
 const logs:Record<string,unknown>={};
 await docker(["run","-d","--name",name,"--label",`axi.eval.batch=${batch.id}`,"--network","none","--read-only","--user","0","--cap-drop=ALL","--cap-add=CHOWN","--cap-add=SETUID","--cap-add=SETGID","--cap-add=SETPCAP","--security-opt","no-new-privileges","--cpus","2","--memory","4g","--pids-limit","256","--tmpfs","/task:rw,nosuid,size=200m,mode=755","--tmpfs","/home/eval:rw,nosuid,size=64m,mode=755","--tmpfs","/tmp:rw,nosuid,size=256m,mode=1777",batch.image]);
 const runtime={name};
 const seed=(files:SeedFiles)=>execute(runtime,["bun","/opt/eval/files.ts","seed"],encodeFiles(files));
 async function run(key:string,args:string[],timeout=60000){const r=await execute(runtime,args,undefined,true,timeout);logs[key]=r;return r;}
 try {
   await seed(Object.fromEntries(Object.entries(final).filter(([,f])=>f.type==="file").map(([p,f])=>[p,Buffer.from(f.data!,"base64")])));
   // 原测试及配置从控制器恢复。篡改已单独记为失败，不能让候选弱化验收。
   await seed(Object.fromEntries(task.protected.map(p=>[p,task.files[p]!])));
   const typecheck=await run("typecheck",["bun","/opt/toolchain/node_modules/typescript/bin/tsc","--noEmit","--project","tsconfig.json"]);
   check("严格类型检查",typecheck.exitCode===0,{exitCode:typecheck.exitCode,stdout:typecheck.stdout.slice(-4000),stderr:typecheck.stderr.slice(-1000)});
   const tests=await run("legacy-tests",["bun","test","tests"]);
   check("原测试与新增回归",tests.exitCode===0,{exitCode:tests.exitCode,stdout:tests.stdout.slice(-1000),stderr:tests.stderr.slice(-2000)});
   await seed({"oracle-probe.ts":readFileSync(join(fixtureRoot,task.id,"oracle/probe.ts.fixture"))});
   if(task.id==="C4")await seed({"oracle-cases.json":JSON.stringify(replayCases().map(({id,text,argv})=>({id,text,argv})))});
   const probe=await run("independent-probe",["bun","oracle-probe.ts"],120000);
   let x:any;try{x=JSON.parse(probe.stdout);}catch{}
   check("独立验收程序完成",probe.exitCode===0&&!!x,{exitCode:probe.exitCode,stderr:probe.stderr.slice(-4000),stdout:probe.stdout.slice(-2000)});
   if(x && task.id==="C1"){
     const a=x.basic;
     check("HTTP、旧读取与 CLI 契约",a?.first?.status===201&&a.first.body?.sku==="tea"&&a.first.body.quantity===2&&typeof a.first.body.id==="string"&&equal(Object.keys(a.first.body).sort(),["id","quantity","sku"])&&equal(a.stock,{status:200,body:{sku:"tea",available:3}})&&equal(a.orders,{status:200,body:[a.first.body]})&&equal(a.cli,{code:0,value:[a.first.body]}),a);
     const s=x.sameKey;
     check("20 次同键并发仅一次业务效果",s?.replies?.length===20&&s.replies.every((r:any)=>r.status===201&&equal(r,s.replies[0]))&&s.state.stock===48&&s.state.orders.length===1,s);
     const r=x.stockRace;
     check("12 次竞争库存 5，无超卖残留",r?.replies?.filter((v:any)=>v.status===201).length===5&&r.replies.filter((v:any)=>equal(v,{status:409,body:{error:"out_of_stock"}})).length===7&&r.state.stock===0&&r.state.orders.length===5,r);
     const c=x.conflict;
     check("重放与键冲突优先于库存检查",c?.a?.status===201&&equal(c.a,c.replay)&&equal(c.b,{status:409,body:{error:"idempotency_conflict"}})&&equal(c.b,c.d)&&c.state.orders.length===1&&c.state.stock===0,c);
     check("三处写入故障完整回滚且同键可重试",Array.isArray(x.rollback)&&x.rollback.length===3&&x.rollback.every((v:any)=>equal(v.failed,{status:500,body:{error:"internal_error"}})&&equal(v.afterFailure,{stock:5,orders:[]})&&v.recovered.status===201&&v.final.stock===3&&v.final.orders.length===1),x.rollback);
     const v=x.invalid;
     check("非法请求与失败键不污染后续请求",v?.invalid?.length===4&&v.invalid.every((r:any)=>equal(r,{status:400,body:{error:"invalid_request"}}))&&equal(v.badJson,{status:400,body:{error:"invalid_request"}})&&equal(v.missing,v.badJson)&&equal(v.failed,{status:409,body:{error:"out_of_stock"}})&&v.retry.status===201&&v.state.stock===1&&v.state.orders.length===1,v);
     check("两个独立进程共享库存与幂等记录",Array.isArray(x.crossProcess)&&x.crossProcess.length===2&&x.crossProcess.every((v:any)=>v.replies.length===2&&v.replies.every((r:any)=>r.code===0)&&v.stock===2&&v.orders.length===1&&(v.sameKey?v.replies.every((r:any)=>r.response.status===201&&equal(r.response,v.replies[0].response)):v.replies.filter((r:any)=>r.response.status===201).length===1&&v.replies.filter((r:any)=>equal(r.response,{status:409,body:{error:"out_of_stock"}})).length===1)),x.crossProcess);
     check("故障钩子错误类型不改变 500 契约",Array.isArray(x.faultTypes)&&x.faultTypes.length===12&&x.faultTypes.every((v:any)=>equal(v.failed,{status:500,body:{error:"internal_error"}})&&equal(v.afterFailure,{stock:5,orders:[]})&&v.retry.status===201&&v.final.stock===3&&v.final.orders.length===1),x.faultTypes);
     const p=x.restart;
     check("提交后丢响应、跨进程重启仍可重放",equal(p?.codes,[0,0,0])&&p.second?.status===201&&equal(p.second,p.third)&&equal(p.stock,{available:7})&&equal(p.orders,[p.second.body]),p);
   } else if(x && task.id==="C2"){
     const old=[{id:"a",title:"原文🙂",status:"todo",created_at:"2017-01-01",updated_at:"2019-01-01"},{id:"b",title:"进行中",status:"doing",created_at:"2018-01-01",updated_at:"2020-01-01"},{id:"c",title:"完成",status:"done",created_at:"2019-01-01",updated_at:"2021-01-01"}];
     const upgraded=old.map((r,i)=>({...r,status:["open","active","done"][i],deleted_at:null}));
     const migrated=(s:any)=>equal(s?.version,{user_version:2})&&equal(s.rows,upgraded);
     check("迁移保持原数据并正确映射",equal(x.normal?.first,{from:1,to:2,count:3,changed:true})&&migrated(x.normal?.before),x.normal);
     check("重复迁移不改变数据与结构",equal(x.normal?.second,{from:2,to:2,count:3,changed:false})&&equal(x.normal?.before,x.normal?.after),x.normal);
     check("迁移后 ID 唯一约束有效",equal(x.unique,{rejected:true,count:3}),x.unique);
     check("空库升级",equal(x.empty?.summary,{from:1,to:2,count:0,changed:true})&&equal(x.empty?.snapshot?.rows,[])&&equal(x.empty?.snapshot?.version,{user_version:2}),x.empty);
     check("dry-run 无业务写入",equal(x.dry?.summary,{from:1,to:2,count:3,changed:false})&&equal(x.dry?.before,x.dry?.after),x.dry);
     check("故障回滚 schema、数据和版本",Array.isArray(x.rollback)&&x.rollback.length===2&&x.rollback.every((r:any)=>r.threw&&equal(r.before,r.after)&&equal(r.recovered,{from:1,to:2,count:3,changed:true})&&migrated(r.final)),x.rollback);
     check("非法旧数据在真实和 dry-run 均拒绝且保留",Array.isArray(x.invalid)&&x.invalid.length===8&&x.invalid.every((r:any)=>r.threw&&equal(r.before,r.after)),x.invalid);
     check("不支持版本拒绝且保留",Array.isArray(x.version)&&x.version.length===2&&x.version.every((r:any)=>r.threw&&equal(r.before,r.after)),x.version);
     const c=x.compat;
     check("新旧 HTTP 和 CLI 兼容，软删除默认隐藏",equal(c?.legacy,old)&&equal(c?.v2,upgraded)&&equal(c?.cliOld,{code:0,value:old})&&equal(c?.cliNew,{code:0,value:upgraded})&&equal(c?.hiddenOld,old.filter(r=>r.id!=="b"))&&equal(c?.hiddenNew,upgraded.filter(r=>r.id!=="b")),c);
     const n=x.concurrent;
     check("两个进程并发迁移且仅一次变更",n?.replies?.length===2&&n.replies.every((r:any)=>r.code===0&&r.value.to===2&&r.value.count===3)&&n.replies.filter((r:any)=>r.value.changed===true).length===1&&migrated(n.snapshot),n);
     const l=x.cli;
     check("CLI dry-run、升级、重跑和错误退出",equal(l?.dry,{code:0,value:{from:1,to:2,count:3,changed:false}})&&equal(l?.before?.version,{user_version:1})&&equal(l?.run,{code:0,value:{from:1,to:2,count:3,changed:true}})&&equal(l?.again,{code:0,value:{from:2,to:2,count:3,changed:false}})&&equal(l?.failed,{code:1,stderr:true})&&equal(l?.bad?.version,{user_version:1}),l);
   } else if(x && task.id==="C4"){
     for(const expected of replayCases()){
       const actual=x.results?.find((r:any)=>r.id===expected.id);
       check(`回放契约 ${expected.id}`,actual?.code===expected.exit&&!actual.timedOut&&(expected.expected?equal(actual.value,expected.expected):!!actual.stderr),actual);
     }
     check("离线、无工具副作用、原文件不变",x.results?.length===replayCases().length&&x.results.every((r:any)=>r.requests===0&&!r.sideEffect&&r.inputPreserved),x.results?.map((r:any)=>({id:r.id,requests:r.requests,sideEffect:r.sideEffect,inputPreserved:r.inputPreserved})));
     check("帮助显示回放入口",x.help?.code===0&&x.help.text.includes("--replay"),x.help);
   }
 } catch(error){check("验收环境完成",false,String(error));}
 finally {await docker(["rm","-f",name],undefined,true);save(join(batch.directory,id,"verification.json"),{checks,logs});}
 return {pass:checks.every(c=>c.pass),checks};
}
