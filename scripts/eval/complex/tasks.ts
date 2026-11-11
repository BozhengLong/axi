import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type SeedFiles } from "../core.ts";
export type ComplexTask = {id:string; files:SeedFiles; protected:string[]; prompts:string[]};
export function tree(directory:string,prefix=""):SeedFiles {
  return Object.fromEntries(readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(tree(join(directory,e.name),prefix+e.name+"/")):[[prefix+e.name.replace(/\.fixture$/,""),readFileSync(join(directory,e.name))]]));
}
export const fixtureRoot = join(ROOT,"evals/complex-v1");
export function complexTasks():ComplexTask[] {return ["C1","C2","C4"].map(id=>{
  const files=tree(join(fixtureRoot,id,"seed"));
  const protectedFiles=Object.keys(files).filter(p=>!p.startsWith("src/") && (p!=="README.md" || id==="C2"));
  return {id,files,protected:protectedFiles,prompts:["请在 /task 完成这份已有项目的任务，使用中文。先阅读 README.md、brief.md 和契约文档，再实现并实际验证。不能联网、安装依赖或启动跨工具调用的后台服务；测试命令可以自行启动并关闭 loopback 服务。原测试和标记的文件不可修改，可以新增测试。工具链已预装，直接使用 bun run typecheck 和 bun test tests。最后说明修改、实际验证结果及未解决问题。"]};
});}
export function reference(task:ComplexTask):SeedFiles{return {...task.files,...tree(join(fixtureRoot,task.id,"reference"))};}
export function mutant(task:ComplexTask,kind:number):SeedFiles {
  const files=reference(task),get=(p:string)=>{const v=files[p]!;return typeof v==="string"?v:Buffer.from(v).toString();};
  if(task.id==="C1"){
    const p="src/services/orders.ts",s=get(p);
    files[p]=kind===0?s.replace('return db.transaction(() => {','return (() => {').replace('}).immediate();','})();'):s.replace('if(previous){','if(previous && process.env.USE_SAVED_KEYS==="1"){');
  } else if(task.id==="C2"){
    const p="src/migrations/upgrade.ts";
    if(kind===0) files[p]=get(p).replace('return db.transaction(():MigrationResult=>{','return (():MigrationResult=>{').replace('}).immediate();','})();');
    else files["src/format/legacy.ts"]=task.files["src/format/legacy.ts"]!;
  } else {
    const p="src/replay.ts";
    files[p]=kind===0?get(p).replace('if(!tool.result)issue(tool.line,"missing_tool_result");','if(false)issue(tool.line,"missing_tool_result");'):get(p).replace('if(typeof d.line!=="string")issue(line,"invalid_record");break;','if(typeof d.line!=="string")issue(line,"invalid_record"); else events.push({kind:"raw_text",line,text:d.line});break;');
  }
  return files;
}
