import {readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {ROOT,save} from '../core.ts';
import {sha} from './source.ts';

export function facilityPaths(task:string){
 const selected=new Set<string>();
 function walk(path:string){for(const name of readdirSync(path).sort()){const file=join(path,name),stat=lstatSync(file);if(stat.isDirectory()&&!['node_modules','.git','__pycache__'].includes(name))walk(file);else if(stat.isFile()&&/\.(ts|py|mjs|cjs)$/.test(name))selected.add(file)}}
 walk(import.meta.dir);walk(join(ROOT,'src'));
 for(const name of ['core.ts','adapters.ts','trace.ts','v1/adapter.ts','v1/preview.ts'])selected.add(join(ROOT,'scripts/eval',name));
 for(const name of readdirSync(task))if(['qualification-profile.json','input-manifest.json','grading-profile.json'].includes(name)||name.endsWith('-patch.json'))selected.add(join(task,name));
 walk(join(task,'qualification-material'));
 return [...selected].sort();
}
export function snapshotFacility(task:string,out:string){
 const archive=join(out,'facility-source');mkdirSync(archive);const records=[];
 for(const path of facilityPaths(task)){const bytes=readFileSync(path),hash=sha(bytes);writeFileSync(join(archive,hash),bytes,{mode:0o600});records.push({path:resolve(path),sha256:hash,bytes:bytes.length})}
 const result={at:new Date().toISOString(),task:resolve(task),sourceHash:sha(JSON.stringify(records)),records};save(join(out,'facility.json'),result);return result;
}
export function verifyFacility(frozen:ReturnType<typeof snapshotFacility>,out:string){
 assert.deepEqual(facilityPaths(frozen.task),frozen.records.map(r=>r.path),'CLI联调期间新增或删除设施文件');
 const changed=frozen.records.filter(r=>sha(readFileSync(r.path))!==r.sha256).map(r=>r.path);save(join(out,'facility-verification.json'),{stable:changed.length===0,changed,sourceHash:frozen.sourceHash});assert.equal(changed.length,0,'CLI联调期间设施或题目输入改变');
}
