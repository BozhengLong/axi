import {test,expect} from "bun:test";
import {recoveryPlan} from "./recovery.ts";
const schedule=Array.from({length:3},(_,i)=>["axi","claude"].map(agent=>({task:"C1",repeat:i+1,agent,id:`r${i+1}-${agent}`}))).flat();
test("环境中断只补完整配对，保留此前结果及后续顺序",()=>{const p=recoveryPlan(schedule,schedule.slice(0,3),{classification:"environment_indeterminate",run:"r2-axi"});expect(p.retainedIds).toEqual(["r1-axi","r1-claude"]);expect(p.excludedIds).toEqual(["r2-axi"]);expect(p.schedule.map(r=>r.id)).toEqual(["r2-axi-retry1","r2-claude-retry1","r3-axi","r3-claude"]);expect(p.schedule.map(r=>r.recoveryAttempt)).toEqual([1,1,0,0]);});
test("配对后半中断也同时保留并标记前半原记录",()=>{const p=recoveryPlan(schedule,schedule.slice(0,4),{classification:"environment_indeterminate",run:"r2-claude"});expect(p.excludedIds).toEqual(["r2-axi","r2-claude"]);expect(p.retainedIds).toEqual(["r1-axi","r1-claude"]);});
test("拒绝将普通产品失败或不完整历史当成补跑理由",()=>{expect(()=>recoveryPlan(schedule,schedule.slice(0,3),{classification:"task_failure",run:"r2-axi"})).toThrow();expect(()=>recoveryPlan(schedule,[schedule[2]!],{classification:"environment_indeterminate",run:"r2-axi"})).toThrow();});
