import {createHash} from "node:crypto";
import {readdirSync,readFileSync} from "node:fs";
import {join,relative} from "node:path";
import {ROOT} from "../core.ts";
export function fingerprint(){
 const walk=(path:string):string[]=>readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(path,e.name)):[join(path,e.name)]);
 const paths=[...['src','scripts/eval','evals','tests'].flatMap(p=>walk(join(ROOT,p))),...['package.json','bun.lock','tsconfig.json','.dockerignore'].map(p=>join(ROOT,p))].sort();
 const hashes=Object.fromEntries(paths.map(p=>[relative(ROOT,p),createHash('sha256').update(readFileSync(p)).digest('hex')]));
 return {hashes,sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
}
