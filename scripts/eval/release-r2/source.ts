import { readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
export const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
export interface SourceManifest { schema: 1; kind: 'development' | 'candidate' | 'historical-control'; commit: string; sourceHash: string; files: {path:string;sha256:string;mode:number}[] }
export function verifySource(root: string, manifest: SourceManifest): void {
  if (manifest.schema!==1 || !['development','candidate','historical-control'].includes(manifest.kind) || !/^[0-9a-f]{40}$/.test(manifest.commit) || manifest.sourceHash!==sha(JSON.stringify(manifest.files))) throw Error('源码清单身份无效');
  const names=new Set<string>();
  for (const file of manifest.files) {
    if(isAbsolute(file.path)||file.path.split('/').some(x=>!x||x==='..'||x==='.')||names.has(file.path))throw Error('源码清单路径无效');names.add(file.path);
    const path=join(root,file.path),stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==file.mode||sha(readFileSync(path))!==file.sha256)throw Error(`源码身份不符：${file.path}`);
  }
  for(const file of ['src/main.ts','src/tools/registry.ts','package.json','bun.lock','tests/fixtures.ts'])if(!names.has(file))throw Error(`缺少必需源码：${file}`);
}
export function loadSource(root: string, file: string): SourceManifest {
  const manifest=JSON.parse(readFileSync(file,'utf8'));verifySource(resolve(root),manifest);return manifest;
}
if(import.meta.main){
  const [rootArg,output,kindArg]=process.argv.slice(2);if(!rootArg||!output||!['development','candidate','historical-control'].includes(kindArg!))throw Error('用法：source.ts 源目录 新清单 development|candidate|historical-control');
  const root=resolve(rootArg),git=(args:string[])=>{const p=Bun.spawnSync(['git','-C',root,...args]);if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString()};
  if(kindArg!=='development'&&git(['status','--porcelain']).trim())throw Error('正式或历史候选必须干净');
  const paths=[...new Set((git(['ls-files'])+(kindArg==='development'?git(['ls-files','--others','--exclude-standard']):'')).trim().split('\n'))].sort();
  const files=paths.map(path=>({path,sha256:sha(readFileSync(join(root,path))),mode:lstatSync(join(root,path)).mode&0o777}));
  const manifest:SourceManifest={schema:1,kind:kindArg as SourceManifest['kind'],commit:git(['rev-parse','HEAD']).trim(),sourceHash:sha(JSON.stringify(files)),files};verifySource(root,manifest);writeFileSync(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({kind:manifest.kind,commit:manifest.commit,sourceHash:manifest.sourceHash,files:files.length}));
}
