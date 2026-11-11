import {expect,test} from "bun:test";
import {encodeFiles} from "../core.ts";
import {pack} from "./grade.ts";
import {complexTasks} from "./tasks.ts";
import {isDeepStrictEqual} from "node:util";
test("二进制种子与快照保留无效 UTF-8 字节",()=>{const bytes=Uint8Array.from([0,255,128,192,0,10,13,250]);const encoded=JSON.parse(encodeFiles({"data.db":bytes}));expect(Buffer.from(encoded["data.db"].data,"base64")).toEqual(Buffer.from(bytes));expect(pack({"data.db":bytes})["data.db"]!.data).toBe(encoded["data.db"].data);});
test("验收比较忽略对象键顺序，但保留数组顺序",()=>{expect(isDeepStrictEqual({a:1,b:[2,3]},{b:[2,3],a:1})).toBe(true);expect(isDeepStrictEqual({b:[2,3]},{b:[3,2]})).toBe(false);});
test("只向候选投递种子，不携带参考实现和验收答案",()=>{const tasks=complexTasks();expect(tasks.map(t=>t.id)).toEqual(["C1","C2","C4"]);for(const task of tasks){expect(Object.keys(task.files).some(p=>/oracle|reference/.test(p))).toBe(false);expect(task.protected).toContain("package.json");expect(task.protected.some(p=>p.startsWith("tests/"))).toBe(true);}const binary=tasks[1]!.files["fixtures/legacy.db"]!;expect(Buffer.from(binary as Uint8Array).subarray(0,16).toString()).toBe("SQLite format 3\u0000");});

import {modelSettingsMatch} from "./settings.ts";
test("effort 只要求生成请求，计数请求仍核对模型",()=>{const request=(path:string,body:unknown)=>({kind:"request",data:{path,body}});const generation=request("/v1/messages",{model:"claude-opus-5-5",output_config:{effort:"medium"}}),count=request("/v1/messages/count_tokens",{model:"claude-opus-5-5"});expect(modelSettingsMatch([generation,count],[{model:"claude-opus-5-5"}])).toBe(true);expect(modelSettingsMatch([count],[])).toBe(false);expect(modelSettingsMatch([request("/v1/messages",{model:"claude-opus-5-5"})],[])).toBe(false);expect(modelSettingsMatch([generation,request("/v1/messages/count_tokens",{model:"other"})],[])).toBe(false);});
