import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {docker,save} from '../core.ts';
import {taskManifest} from '../v1/tasks.ts';
import {STUDY,IMAGE,tasks,read,authorization} from './config.ts';
authorization();const rows=[];
const script='import{readdirSync,lstatSync,readFileSync,readlinkSync}from"node:fs";import{createHash}from"node:crypto";const hash=createHash("sha256");let count=0;function walk(path){for(const name of readdirSync(path).sort()){const p=path+"/"+name,s=lstatSync(p);hash.update(p+":"+s.mode+":");if(s.isDirectory())walk(p);else if(s.isSymbolicLink())hash.update(readlinkSync(p));else if(s.isFile())hash.update(readFileSync(p));else throw Error("special dependency file");count++}}walk("/deps/node_modules");console.log(JSON.stringify({sha256:hash.digest("hex"),count}));';
for(const task of tasks){const volume=taskManifest(task).dependencyVolume;const r=await docker(['run','--rm','--network','none','--read-only','--entrypoint','bun','--mount',`type=volume,src=${volume},dst=/deps,readonly`,IMAGE,'-e',script],undefined,true,120000);if(r.exitCode||r.timedOut)throw Error('依赖校验失败');rows.push({task,volume,...JSON.parse(r.stdout)})}
const path=join(STUDY,'dependency-baseline.json');if(!existsSync(path))save(path,rows);else if(JSON.stringify(rows)!==JSON.stringify(read(path)))throw Error('只读依赖内容改变');save(join(STUDY,'dependency-check-'+Date.now()+'.json'),rows);console.log(JSON.stringify({complete:true,rows}));
