import{join}from'node:path';
import{existsSync}from'node:fs';
import{docker,save}from'../core.ts';
import{snapshotHash,file,contents}from'../v1/tasks.ts';
import{authorization,STUDY,IMAGE,read}from'./config.ts';
const a=authorization();
if(process.argv[2]!=='--offline')throw Error('需要显式 --offline');
const script=`import{realpathSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';const h=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const versions={};for(const cmd of ['node','bun','claude','npm','pnpm']){const r=Bun.spawnSync([cmd,'--version']);if(r.exitCode)throw Error(cmd+' version failed');versions[cmd]=r.stdout.toString().trim()}const paths=['node','bun','claude'].map(n=>{const p=Bun.which(n);if(!p)throw Error('missing executable '+n);return p});console.log(JSON.stringify({versions,binaries:paths.map(p=>({path:p,realpath:realpathSync(p),sha256:h(p),header:readFileSync(p).subarray(0,80).toString('hex')})),typescript:JSON.parse(readFileSync('/opt/toolchain/node_modules/typescript/package.json','utf8')).version}));`;
const records:any[]=[];
for(const image of [a.baseImage,IMAGE]){
 const r=await docker(['run','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','4g','--cpus','2','--entrypoint','bun',image,'-e',script]);records.push({image,...JSON.parse(r.stdout)});
}
const [base,next]=records,origin=read(join(STUDY,'node-origin.json'));
if(next.versions.node!=='v22.23.5'||next.typescript!=='5.9.3'||!next.versions.claude.startsWith('2.1.322')||next.versions.bun!=='1.3.14'||next.versions.pnpm!=='10.34.9'||next.versions.npm!==base.versions.npm)throw Error('工具版本不符');
if(next.binaries[0].sha256!==origin.binarySha256||next.binaries.slice(1).some((x:any,i:number)=>x.sha256!==base.binaries[i+1].sha256))throw Error('非目标二进制改变');
for(const id of ['A','B']){
 const d=join(STUDY,'tasks',id),manifest=read(join(d,'manifest.json')),old=read(join(d,'input.json'));
 if(existsSync(join(d,'node24-input.json')))throw Error('输入已经转换，不重复覆盖');
 if(snapshotHash(old)!==manifest.inputSha256)throw Error('来源输入哈希不符');
 save(join(d,'node24-input.json'),old);save(join(d,'node24-manifest.json'),manifest);
 const text=contents(old['eval/environment.md']);if(!text.includes('Node 24.22.2'))throw Error('原环境说明缺失');
 const files={...old,'eval/environment.md':file(text.replace('Node 24.22.2','Node 22.23.5'))};
 save(join(d,'input.json'),files);save(join(d,'manifest.json'),{...manifest,revision:manifest.revision+1,sourceInputSha256:manifest.inputSha256,inputSha256:snapshotHash(files),reason:'稳定化D1：仅更新公开Node版本说明，功能/依赖/验收不变',sourceStudy:a.sourceStudy});
}
save(join(STUDY,'image-inspection.json'),{complete:true,records,nodeOrigin:origin});
const {deadlineMs,workDeadline,...auth}=a;save(join(STUDY,'authorization.json'),{...auth,image:IMAGE});
console.log(JSON.stringify({image:IMAGE,versions:next.versions,typescript:next.typescript,claudeHeader:next.binaries[2].header.slice(0,32),cliBinaryUnchanged:true}));
