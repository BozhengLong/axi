import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, renameSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// P-02 / 设计07第4节：确认期间身份变化必须使原提案失效。
// 在批准回调中完成真实rename，随后返回y；不用sleep决定竞争结果。
const [candidateArg, outputArg, platform] = process.argv.slice(2);
if (!candidateArg || !outputArg || !platform) throw new Error('需要C目录、证据目录、平台');
const candidate = resolve(candidateArg), output = resolve(outputArg);
mkdirSync(output, {recursive:true});
const planPath = join(output, 'identity-plan.json');
if (await Bun.file(planPath).exists()) throw new Error('拒绝覆盖已有检查');
const plan = { candidate: '0f4a2c4df87b01d6290ff81dfea2541a5169e2ae', platform, repeats:5, tools:['read','glob','grep'], variants:['unchanged','replace-target','replace-parent'], expected: 'unchanged succeeds; changed identity rejects before revealing replacement; files/modes/Git untouched by subject', contract:['P-02','docs/07-v1-design.md:116'], createdAt:new Date().toISOString() };
writeFileSync(planPath,JSON.stringify(plan,null,2));
const { Agent } = await import(join(candidate,'src/agent/loop.ts'));
const { response, textResponse } = await import(join(candidate,'tests/fixtures.ts'));
const rows: any[]=[];
for(const toolName of plan.tools) for(const variant of plan.variants) for(let repeat=1;repeat<=5;repeat++) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'axi-release-identity-'))), logs:any[]=[];
 mkdirSync(join(root,'sub'));writeFileSync(join(root,'sub/a.txt'),'original needle\n');writeFileSync(join(root,'bystander.txt'),'user dirty keep\n');
 const git=(args:string[])=>{const p=Bun.spawnSync(['git','-C',root,...args]);if(p.exitCode!==0)throw Error(p.stderr.toString());return p.stdout.toString()};
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial']);
 writeFileSync(join(root,'bystander.txt'),'user dirty keep\nmore user changes\n');
 const snapshot=()=>{const files:any[]=[];const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){if(name==='.git')continue;const path=join(dir,name),s=statSync(path);if(s.isDirectory())walk(path);else files.push({path:path.slice(root.length+1),mode:s.mode&0o777,bytes:readFileSync(path).toString('base64')})}};walk(root);return {files,head:git(['rev-parse','HEAD']),index:git(['ls-files','--stage'])}};
 const initial=snapshot();let approved:any, callCount=0;
 const target=toolName==='read'?'sub/a.txt':'sub';
 const tool={type:'tool_use' as const,id:'inspect',name:toolName,input:{path:target,...(toolName==='read'?{}:{pattern:toolName==='glob'?'**/*.txt':'needle'})}};
 const agent=new Agent({cwd:root,reviewMode:()=> 'off',permissionMode:()=> 'strict',record:(kind:string,data:any)=>logs.push({kind,data}),call:async()=> ++callCount===1?response([tool],'tool_use'):textResponse('done'),approve:async()=>{
  if(variant==='replace-target') {
   renameSync(join(root,target),join(root,target+'.old'));
   if(toolName==='read')writeFileSync(join(root,target),'replacement needle MUST_NOT_READ\n');
   else {mkdirSync(join(root,target));writeFileSync(join(root,target,'replacement.txt'),'replacement needle MUST_NOT_READ\n')}
  } else if(variant==='replace-parent') {
   renameSync(join(root,'sub'),join(root,'sub.old'));mkdirSync(join(root,'sub'));writeFileSync(join(root,'sub/a.txt'),'replacement needle MUST_NOT_READ\n');
  }
  approved=snapshot();return {allowed:true};
 }});
 let error:string|undefined;
 try{await agent.run('inspect',{signal:new AbortController().signal,effort:'medium'})}catch(e){error=String(e)}
 const history=structuredClone(agent.history);const result=history.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).find((x:any)=>x.type==='tool_result');
 const parsed=result?JSON.parse(result.content):null;const after=snapshot();
 const unchanged=JSON.stringify(approved)===JSON.stringify(after), rejected=result?.is_error===true;
 const passed=unchanged&&!error&&(variant==='unchanged'?!!result&&!rejected:rejected&&!JSON.stringify(result).includes('MUST_NOT_READ'));
 const row={id:`${toolName}-${variant}-${repeat}`,toolName,variant,repeat,passed,rejected,result:parsed,error,unchanged,callCount,initial,approved,after,history,logs};
 writeFileSync(join(output,`${row.id}.json`),JSON.stringify(row,null,2));rows.push({id:row.id,passed,rejected,code:parsed?.code,unchanged});
 rmSync(root,{recursive:true,force:true});
}
writeFileSync(join(output,'identity-results.json'),JSON.stringify({plan,rows,passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length,productHash:createHash('sha256').update(readFileSync(join(candidate,'src/tools/registry.ts'))).digest('hex')},null,2));
console.log(JSON.stringify({total:rows.length,passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length,groups:rows.filter(x=>!x.passed).map(x=>x.id)}));
