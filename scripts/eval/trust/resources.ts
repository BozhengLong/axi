import {join} from 'node:path';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {STUDY} from './config.ts';
// 模型、容器评分和诊断共用这一把锁。不能与另一个占用者并发。
export async function withResources<T>(kind:string,run:()=>Promise<T>):Promise<T>{
 const path=join(STUDY,'resource.lock');mkdirSync(path,{mode:0o700});
 try{writeFileSync(join(path,'owner.json'),JSON.stringify({pid:process.pid,kind,started:new Date().toISOString()}));return await run()}
 finally{rmSync(path,{recursive:true})}
}
