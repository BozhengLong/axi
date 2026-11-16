import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, chmodSync, statSync, symlinkSync, linkSync, unlinkSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ProjectPaths } from "../src/tools/paths.ts";
import { Agent } from "../src/agent/loop.ts";
import type { FileHooks } from "../src/tools/files.ts";
import type { ToolUse, ToolResult } from "../src/api/types.ts";
import { response, textResponse } from "./fixtures.ts";

const parents: string[] = [];
let currentName = "";
function test(name: string, body: () => Promise<void> | void) { bunTest(name, async () => { currentName = name; await body(); }); }
const expected = new Map<string, { files: unknown[]; head: string; index: string }>();
const initialGit = new Map<string, { head: string; index: string }>();
function inventory(parent: string) {
  const files: unknown[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { if (name === ".git") continue; const path=join(dir,name), stat=lstatSync(path); files.push({path:path.slice(parent.length+1),dev:stat.dev,ino:stat.ino,mode:stat.mode,links:stat.nlink,...(stat.isFile()?{bytes:readFileSync(path).toString("base64")}:stat.isSymbolicLink()?{link:readlinkSync(path)}:{})}); if(stat.isDirectory())walk(path); } };
  walk(parent);
  const root = [join(parent,"project"),join(parent,"project.old")].find(p=> {try{return lstatSync(join(p,".git")).isDirectory()}catch{return false}})!;
  const git=(args:string[])=>{const r=Bun.spawnSync(["git","-C",root,...args],{env:{PATH:process.env.PATH,HOME:parent,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}});if(r.exitCode)throw Error(r.stderr.toString());return r.stdout.toString()};
  return {files,head:git(["rev-parse","HEAD"]),index:git(["ls-files","--stage"])};
}
function saveExpected(root: string) { const parent=parents.find(p=>root===join(p,"project"))!; expected.set(parent,inventory(parent)); }

const signal = () => new AbortController().signal;
const parsed = (x: {content: string}) => JSON.parse(x.content);
function fixture(hooks: FileHooks = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "axi-binding-"))); parents.push(parent);
  const root = join(parent, "project"); mkdirSync(join(root, "top/inner"), {recursive:true});
  writeFileSync(join(root, "top/inner/a.txt"), "original needle\n"); writeFileSync(join(root, "user.txt"), "original user\n");
  for (const args of [["init","-q"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","initial"]]) { const p=Bun.spawnSync(["git","-C",root,...args],{env:{PATH:process.env.PATH,HOME:parent,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}});if(p.exitCode)throw Error(p.stderr.toString()); }
  writeFileSync(join(root,"user.txt"),"user dirty\n");saveExpected(root);const state=expected.get(parent)!;initialGit.set(parent,{head:state.head,index:state.index});
  return {root, registry: new ToolRegistry(root, undefined, hooks)};
}
const tool = (name: string, path: string, id = "inspect"): ToolUse => ({type:"tool_use",id,name,input:{path,...(name === "read" ? {} : {pattern:name === "glob" ? "**/*.txt" : "needle"})}});
function replace(root: string, path: string, same = false) {
  const target = join(root,path), directory = statSync(target).isDirectory(); renameSync(target,target+".old");
  if(directory) {mkdirSync(target);writeFileSync(join(target,"replacement.txt"),"MUST_NOT_READ needle\n")}
  else writeFileSync(target,same?"original needle\n":"MUST_NOT_READ needle\n");
  saveExpected(root);
}
function unchangedUser(root:string) {expect(readFileSync(join(root,"user.txt"),"utf8")).toBe("user dirty\n")}
afterEach(()=>{for(const p of parents.splice(0)) {
  try {const before=expected.get(p)!,after=inventory(p),git=initialGit.get(p)!;
    const evidence=process.env.AXI_P02_TEST_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});const id=createHash("sha256").update(currentName+p).digest("hex");writeFileSync(join(evidence,id+".json"),JSON.stringify({test:currentName,before,after,initialGit:git},null,2));}
    expect(after).toEqual(before);expect({head:after.head,index:after.index}).toEqual(git);
  } finally {expected.delete(p);initialGit.delete(p);rmSync(p,{recursive:true,force:true});}
}});

for(const name of ["read","glob","grep"]) for(const kind of name === "read" ? ["file"] : ["file","directory"]) {
  const path = kind === "file" ? "top/inner/a.txt" : "top/inner";
  for(const mutation of ["replace","same-content","parent-with-same-leaf","mode-target","mode-parent"]) test(`B02/B03/B04 ${name}/${kind}/${mutation}：拒绝旧身份`,async()=>{
    const {root,registry}=fixture(), p=await registry.prepare(tool(name,path),signal());
    if(mutation==="replace"||mutation==="same-content")replace(root,path,mutation==="same-content");
    else if(mutation==="parent-with-same-leaf"){
      const parentPath=kind==="file"?"top/inner":"top",leaf=kind==="file"?"a.txt":"inner";
      const before=statSync(join(root,path)).ino;renameSync(join(root,parentPath),join(root,parentPath+".saved"));mkdirSync(join(root,parentPath));renameSync(join(root,parentPath+".saved",leaf),join(root,path));expect(statSync(join(root,path)).ino).toBe(before);
    } else chmodSync(join(root,mutation==="mode-target"?path:"top"),0o700);
    saveExpected(root);await expect(p.execute(signal())).rejects.toHaveProperty("code","path_changed");unchangedUser(root);
  });
  test(`B06 ${name}/${kind}：内容与目录项变化不冒充身份变化`,async()=>{
    const {root,registry}=fixture(), p=await registry.prepare(tool(name,path),signal()), before=statSync(join(root,path)).ino;
    writeFileSync(join(root,"top/inner/a.txt"),"updated needle\n");mkdirSync(join(root,"top/inner/new-sub"));writeFileSync(join(root,"top/inner/new-sub/b.txt"),"added needle\n");
    saveExpected(root);expect(statSync(join(root,path)).ino).toBe(before);const result=parsed(await p.execute(signal()));
    if(name==="read")expect(result.content).toBe("updated needle\n");
    else if(kind==="directory")expect(result.results).toHaveLength(2);
    else expect(result.results).toHaveLength(1);
    expect(result.status).toBe("completed");unchangedUser(root);
  });
}

for(const name of ["read","glob","grep"]) test(`B03 ${name}：根替换使本会话持续失效`,async()=>{
  const {root,registry}=fixture(), p=await registry.prepare(tool(name,"top/inner/a.txt"),signal());renameSync(root,root+".old");mkdirSync(join(root,"top/inner"),{recursive:true});writeFileSync(join(root,"top/inner/a.txt"),"replacement needle\n");saveExpected(root);
  await expect(p.execute(signal())).rejects.toHaveProperty("code","path_changed");await expect(registry.prepare(tool(name,"top/inner/a.txt"),signal())).rejects.toHaveProperty("code","path_changed");
  const fresh=new ToolRegistry(root);expect((await (await fresh.prepare(tool(name,"top/inner/a.txt"),signal())).execute(signal())).isError).toBe(false);
});

for(const [phase,name,path] of [["read_chunk","read","top/inner/a.txt"],["read_result","read","top/inner/a.txt"],["directory_open","glob","top/inner"],["directory_open","grep","top/inner"],["search_entry","glob","top/inner"],["search_entry","grep","top/inner"],["read_chunk","grep","top/inner"],["search_result","glob","top/inner"],["search_result","grep","top/inner"]] as const) {
 for(const change of [false,true]) test(`B05 ${name}/${phase}/${change?"replaced":"control"}：已打开后仍核验`,async()=>{
  let root="",touched=false;
  const f=fixture({checkpoint(at){if(at===phase&&!touched){touched=true;if(change)replace(root,path)}}});root=f.root;
  const p=await f.registry.prepare(tool(name,path),signal()), events:any[]=[];
  if(change)await expect(p.execute(signal(),(kind,data)=>events.push({kind,data}))).rejects.toHaveProperty("code","path_changed");
  else expect((await p.execute(signal(),(kind,data)=>events.push({kind,data}))).isError).toBe(false);
  expect(touched).toBe(true);expect(events.some(x=>x.data.outcome===(change?"invalidated":"valid"))).toBe(true);expect(JSON.stringify(events)).not.toContain("MUST_NOT_READ");unchangedUser(root);
 });
}

test("B04：消失、symlink、FIFO、硬链接和设备返回具体原因，不阻塞读取",async()=>{
 for(const [mutation,code] of [["missing","ENOENT"],["symlink","symlink"],["fifo","special_file"],["hardlink","hardlink"]]){
  const {root,registry}=fixture(),path="top/inner/a.txt",p=await registry.prepare(tool("read",path),signal());
  if(mutation==="hardlink")linkSync(join(root,path),join(root,"alias.txt"));
  else {unlinkSync(join(root,path));if(mutation==="symlink")symlinkSync("../../user.txt",join(root,path));if(mutation==="fifo")expect(Bun.spawnSync(["mkfifo",join(root,path)]).exitCode).toBe(0)}
  saveExpected(root);await expect(p.execute(signal())).rejects.toHaveProperty("code",code);unchangedUser(root);
 }
 expect(()=>new ProjectPaths("/dev").check("null")).toThrow(expect.objectContaining({code:"special_file"}));
});

test("B07：输入不可变，已使用和并发的同一提案不能再次读取",async()=>{
 let entered!:()=>void,release!:()=>void;const barrier=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let held=false;
 const {root,registry}=fixture({async checkpoint(phase){if(phase==="read_chunk"&&!held){held=true;entered();await barrier}}});
 const original=tool("read","top/inner/a.txt"),p=await registry.prepare(original,signal());original.input.path="user.txt";
 expect(()=>{p.tool.input.path="user.txt"}).toThrow();expect(()=>{p.readBinding!.digest="fake"}).toThrow();
 const run=p.execute(signal());await ready;
 try{await expect(p.execute(signal())).rejects.toHaveProperty("code","invalid_proposal")}finally{release();await run.catch(()=>{})}
 expect(parsed(await run).content).toBe("original needle\n");await expect(p.execute(signal())).rejects.toHaveProperty("code","invalid_proposal");unchangedUser(root);
});

for(const mode of ["project","strict"] as const) test(`B07/B08/B10 ${mode}：旧调用失败、新调用恢复且日志不泄漏替代正文`,async()=>{
 const {root,registry}=fixture();let calls=0,approvals=0,touched=false;const events:any[]=[];
 const agent=new Agent({cwd:root,registry,reviewMode:()=>"off",permissionMode:()=>mode,record:(kind,data)=>events.push({kind,data}),call:async()=> ++calls===1?response([tool("read","top/inner/a.txt","first")],"tool_use"):calls===3?response([tool("read","top/inner/a.txt","second")],"tool_use"):textResponse(),onToolStart(){if(!touched){touched=true;replace(root,"top/inner/a.txt")}},approve:async()=>{approvals++;return{allowed:true}}});
 await agent.run("old",{signal:signal(),effort:"medium"});const first=agent.history[2]!.content as ToolResult[];
 expect(parsed(first[0]!).code).toBe("path_changed");expect(first[0]!.is_error).toBe(true);expect(JSON.stringify(agent.history)).not.toContain("MUST_NOT_READ");expect(JSON.stringify(events)).not.toContain("MUST_NOT_READ");
 const prepared=events.find(x=>x.kind==="read_identity_prepared"), permission=events.find(x=>x.kind==="permission"),invalidated=events.find(x=>x.kind==="read_identity_check");
 expect(events.indexOf(prepared)).toBeLessThan(events.indexOf(permission));expect(prepared.data.bindingId).toBe(invalidated.data.bindingId);expect(prepared.data.toolUseId).toBe(permission.data.toolUseId);
 await agent.run("fresh",{signal:signal(),effort:"medium"});expect(JSON.stringify(agent.history)).toContain("MUST_NOT_READ");expect(approvals).toBe(mode==="strict"?2:0);unchangedUser(root);
});

test("B08：拒绝、取消、下一轮及同批工具配对保持",async()=>{
 const {root}=fixture();let calls=0;const abort=new AbortController();
 const agent=new Agent({cwd:root,reviewMode:()=>"off",permissionMode:()=>"strict",call:async()=> ++calls===1?response([tool("read","top/inner/a.txt","deny"),tool("read","top/inner/a.txt","cancel"),tool("read","top/inner/a.txt","later")],"tool_use"):textResponse(),approve:async t=>{if(t.id==="deny")return {allowed:false,reason:"keep original"};abort.abort();return{allowed:true}}});
 await expect(agent.run("stop",{signal:abort.signal,effort:"medium"})).rejects.toHaveProperty("name","AbortError");const rows=agent.history[2]!.content as ToolResult[];
 expect(rows.map(x=>x.tool_use_id)).toEqual(["deny","cancel","later"]);expect(parsed(rows[0]!).code).toBe("user_denied");expect(rows[0]!.content).toContain("keep original");expect(parsed(rows[1]!).status).toBe("cancelled");expect(parsed(rows[2]!).status).toBe("cancelled");expect(calls).toBe(1);
 await agent.run("continue",{signal:signal(),effort:"medium"});expect(calls).toBe(2);unchangedUser(root);
});

test("B09：读取中内容变化仍失败；绑定不是内容快照",async()=>{
 let root="",once=false;const f=fixture({checkpoint(phase){if(phase==="read_chunk"&&!once){once=true;writeFileSync(join(root,"top/inner/a.txt"),"longer changed needle\n");saveExpected(root)}}});root=f.root;
 const p=await f.registry.prepare(tool("read","top/inner/a.txt"),signal());await expect(p.execute(signal())).rejects.toHaveProperty("code","file_changed");unchangedUser(root);
});

for(const event of ["read_identity_prepared","read_identity_check"]) test(`B09 ${event}：日志失败不得继续请求或读出内容`,async()=>{
 const {root}=fixture();let calls=0;const agent=new Agent({cwd:root,reviewMode:()=>"off",record:kind=>{if(kind===event)throw Error("log closed")},call:async()=>{calls++;return response([tool("read","top/inner/a.txt")],"tool_use")},approve:async()=>({allowed:true})});
 const notice=await agent.run("read",{signal:signal(),effort:"medium"});expect(notice).toContain("日志写入失败");expect(calls).toBe(1);expect(JSON.stringify(agent.history)).not.toContain("original needle");unchangedUser(root);
});

test("B09：允许范围内的普通候选错误仍按skip，不误报整个范围失效",async()=>{
 const {root,registry}=fixture();writeFileSync(join(root,"top/inner/binary.txt"),Buffer.from([0]));symlinkSync("a.txt",join(root,"top/inner/link.txt"));
 saveExpected(root);const out=parsed(await (await registry.prepare(tool("grep","top/inner"),signal())).execute(signal()));expect(out.status).toBe("completed");expect(out.incomplete).toBe(true);expect(out.skipped.binary_file).toBe(1);expect(out.skipped.symlink).toBe(1);expect(out.results).toHaveLength(1);
 expect(readdirSync(root).some(x=>x.startsWith(".axi-tmp-"))).toBe(false);
});

for(const name of ["read","glob","grep"]) test(`B02 ${name}：绝对内部路径保持原绑定`,async()=>{
 const {root,registry}=fixture(),path=join(root,"top/inner/a.txt");
 expect((await (await registry.prepare(tool(name,path),signal())).execute(signal())).isError).toBe(false);
 const p=await registry.prepare(tool(name,path),signal());replace(root,"top/inner/a.txt",true);await expect(p.execute(signal())).rejects.toHaveProperty("code","path_changed");unchangedUser(root);
});

for(const name of ["read","glob","grep"]) for(const direction of name==="read"?["file-to-directory"]:["file-to-directory","directory-to-file"]) test(`B04 ${name}/${direction}：对象类型变化拒绝`,async()=>{
 const {root,registry}=fixture(),path=direction==="file-to-directory"?"top/inner/a.txt":"top/inner",p=await registry.prepare(tool(name,path),signal());
 renameSync(join(root,path),join(root,path+".old"));if(direction==="file-to-directory")mkdirSync(join(root,path));else writeFileSync(join(root,path),"replacement needle\n");saveExpected(root);
 await expect(p.execute(signal())).rejects.toHaveProperty("code",name==="read"?"not_file":"path_changed");unchangedUser(root);
});

test("B08：读取前取消会消耗旧提案，新提案仍能读取",async()=>{
 const {root,registry}=fixture(),p=await registry.prepare(tool("read","top/inner/a.txt"),signal()),c=new AbortController();c.abort();
 await expect(p.execute(c.signal)).rejects.toHaveProperty("name","AbortError");await expect(p.execute(signal())).rejects.toHaveProperty("code","invalid_proposal");
 expect(parsed(await (await registry.prepare(tool("read","top/inner/a.txt"),signal())).execute(signal())).content).toBe("original needle\n");unchangedUser(root);
});

test("B08：首项读取成功后取消第二项，已完成结果保留而队列停止",async()=>{
 const {root}=fixture(),c=new AbortController();let calls=0;const agent=new Agent({cwd:root,reviewMode:()=>"off",permissionMode:()=>"strict",call:async()=>{calls++;return response([tool("read","top/inner/a.txt","first"),tool("read","top/inner/a.txt","second"),tool("read","top/inner/a.txt","third")],"tool_use")},approve:async t=>{if(t.id==="second")c.abort();return{allowed:true}}});
 await expect(agent.run("read",{signal:c.signal,effort:"medium"})).rejects.toHaveProperty("name","AbortError");const rows=agent.history[2]!.content as ToolResult[];
 expect(parsed(rows[0]!).content).toBe("original needle\n");expect(parsed(rows[1]!).status).toBe("cancelled");expect(parsed(rows[2]!).status).toBe("cancelled");expect(calls).toBe(1);unchangedUser(root);
});

for(const name of ["read","glob"] as const) test(`B09 ${name}：已打开句柄后失效，连续八次不遗留描述符`,async()=>{
 let root="",armed=false,index=0;const path=name==="read"?"top/inner/a.txt":"top/inner",phase=name==="read"?"read_chunk":"directory_open";
 const f=fixture({checkpoint(at){if(at===phase&&armed){armed=false;renameSync(join(root,path),join(root,path+".old-"+(index++)));if(name==="read")writeFileSync(join(root,path),"new needle\n");else{mkdirSync(join(root,path));writeFileSync(join(root,path,"new.txt"),"new needle\n")}saveExpected(root)}}});root=f.root;
 await (await f.registry.prepare(tool(name,path),signal())).execute(signal());const count=()=>readdirSync(process.platform==="linux"?"/proc/self/fd":"/dev/fd").length,before=count();
 for(let i=0;i<8;i++){const p=await f.registry.prepare(tool(name,path),signal());armed=true;await expect(p.execute(signal())).rejects.toHaveProperty("code","path_changed")}
 expect(index).toBe(8);expect(count()).toBeLessThanOrEqual(before);unchangedUser(root);
});
