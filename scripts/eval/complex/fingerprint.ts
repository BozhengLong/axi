import {createHash} from "node:crypto";
import {readdirSync,readFileSync,existsSync} from "node:fs";
import {join,relative} from "node:path";
import {ROOT} from "../core.ts";
export function fingerprint(){
 const walk=(path:string):string[]=>readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(path,e.name)):[join(path,e.name)]);
 // C7 加载器直接使用这份来源清单。冻结时必须一起保存，才能离线复现。
 const inputs=['docs/verification/2026-11-11-c7-source-review.json'].map(p=>join(ROOT,p)).filter(existsSync);
 const paths=[...['src','scripts/eval','evals','tests'].flatMap(p=>walk(join(ROOT,p))),...['package.json','bun.lock','tsconfig.json','.dockerignore'].map(p=>join(ROOT,p)),...inputs].sort();
 const hashes=Object.fromEntries(paths.map(p=>[relative(ROOT,p),createHash('sha256').update(readFileSync(p)).digest('hex')]));
 return {hashes,sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
}
