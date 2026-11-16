import { mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { loadSource,verifySource,sha } from './source.ts';
const [rootArg,manifestArg,outputArg,platform]=process.argv.slice(2);if(!rootArg||!manifestArg||!outputArg||!platform)throw Error('需要源码、清单、新证据目录和平台');
const root=resolve(rootArg),output=resolve(outputArg),identity=loadSource(root,manifestArg);
mkdirSync(output); // 已存在即拒绝覆盖。
type Edit={file:string;before:string;after:string};
const paths='src/tools/paths.ts',registry='src/tools/registry.ts',search='src/tools/search.ts';
const variants:{id:string;pattern:string;edits:Edit[]}[]=[
 {id:'target',pattern:'^B02/B03/B04 read/file/replace：',edits:[{file:paths,before:'this.readIdentity(current.stat!) !== binding.target',after:'false'}]},
 {id:'parents',pattern:'^B02/B03/B04 read/file/parent-with-same-leaf：',edits:[{file:paths,before:'current.parents !== binding.parents',after:'false'}]},
 {id:'mode',pattern:'^B02/B03/B04 read/file/mode-target：',edits:[{file:paths,before:'return stat.isDirectory() ? this.directoryIdentity(stat) : identity(stat);',after:'return `${stat.dev}:${stat.ino}:${stat.nlink}`;'}]},
 {id:'late',pattern:'^B05 glob/search_result/replaced：',edits:[{file:registry,before:'const guard: ReadGuard = phase => {',after:'const guard: ReadGuard = phase => { if (phase !== "execute") return;'}]},
 {id:'swallow',pattern:'^B05 glob/directory_open/replaced：',edits:[{file:registry,before:'const guard: ReadGuard = phase => {',after:'const guard: ReadGuard = phase => { if (phase === "complete" || phase.startsWith("search_result")) return;'}, {file:search,before:'if (signal.aborted || error instanceof ReadBindingError) throw error;',after:'if (signal.aborted) throw error;'}]},
 {id:'overstrict',pattern:'^B06 glob/directory：',edits:[{file:paths,before:'return stat.isDirectory() ? this.directoryIdentity(stat) : identity(stat);',after:'return stat.isDirectory() ? `${this.directoryIdentity(stat)}:${stat.nlink}:${stat.mtimeMs}` : `${identity(stat)}:${stat.size}`;'}]},
 {id:'reuse',pattern:'^B07：输入不可变',edits:[{file:registry,before:'if (consumed) throw new ToolError',after:'if (false) throw new ToolError'}]},
];
writeFileSync(join(output,'plan.json'),JSON.stringify({identity,platform,repeats:5,variants,createdAt:new Date().toISOString()},null,2));
const rows:any[]=[];
async function command(cwd:string,args:string[],prefix:string){
 const started=Date.now(),child=Bun.spawn(args,{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR??'/tmp',LANG:'en_US.UTF-8'},stdout:Bun.file(prefix+'.stdout'),stderr:Bun.file(prefix+'.stderr')});
 let timeout=false;const timer=setTimeout(()=>{timeout=true;child.kill('SIGKILL')},60_000);const code=await child.exited;clearTimeout(timer);return{args,code,timeout,elapsedMs:Date.now()-started};
}
for(const variant of variants){
 const dir=join(output,variant.id);mkdirSync(dir);const product=join(dir,'product');mkdirSync(product);
 for(const file of identity.files){const target=join(product,file.path);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(join(root,file.path),target);chmodSync(target,file.mode)}
 cpSync(join(root,'node_modules'),join(product,'node_modules'),{recursive:true});
 for(const edit of variant.edits){const path=join(product,edit.file),before=readFileSync(path,'utf8');if(!before.includes(edit.before))throw Error(`变体未命中：${variant.id}`);writeFileSync(path,before.replaceAll(edit.before,edit.after));}
 const files=identity.files.map(file=>({...file,sha256:sha(readFileSync(join(product,file.path)))})),mutated={...identity,kind:'development' as const,files,sourceHash:sha(JSON.stringify(files))};verifySource(product,mutated);writeFileSync(join(dir,'source.json'),JSON.stringify(mutated,null,2));
 const compile=await command(product,['bun','run','typecheck'],join(dir,'typecheck'));if(compile.code!==0||compile.timeout)throw Error(`变体不能编译：${variant.id}`);
 for(let repeat=1;repeat<=5;repeat++){
  // 相同选择器先验证未变源码的合法路径，再要求变体出现真实行为断言失败。
  const positive=join(dir,`positive-${repeat}`),negative=join(dir,`negative-${repeat}`);
  const pass=await command(root,['bun','test','tests/read-binding.test.ts','--test-name-pattern',variant.pattern,'--reporter=junit',`--reporter-outfile=${positive}.xml`],positive);
  const fail=await command(product,['bun','test','tests/read-binding.test.ts','--test-name-pattern',variant.pattern,'--reporter=junit',`--reporter-outfile=${negative}.xml`],negative);
  const good=readFileSync(positive+'.xml','utf8'),bad=readFileSync(negative+'.xml','utf8'),stderr=readFileSync(negative+'.stderr','utf8');
  // 这里登记原始测量；assertion审计另外核对实际用例、失败来源和退出码。
  const row={id:variant.id,repeat,positive:pass,negative:fail,hasPositiveCase:good.includes('<testcase'),hasFailure:bad.includes('<failure'),compilePassed:true,qualified:pass.code===0&&!pass.timeout&&fail.code===1&&!fail.timeout&&bad.includes('<failure')&&!/SyntaxError|Cannot find module|Timed out|Failed to resolve/.test(stderr)};
  rows.push(row);writeFileSync(join(output,'results.json'),JSON.stringify({sourceHash:identity.sourceHash,rows},null,2));console.log(JSON.stringify({id:row.id,repeat,qualified:row.qualified}));
 }
 verifySource(product,mutated);
}
verifySource(root,identity);if(rows.some(x=>!x.qualified))process.exitCode=1;
