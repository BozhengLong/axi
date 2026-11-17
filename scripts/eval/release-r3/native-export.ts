import {lstatSync, readdirSync, openSync, closeSync, readSync, fstatSync, constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// 由宿主冻结任务进程后启动。逐文件逐块输出，不把全部原生日志塞进一个JSON。
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const issues: string[] = [];
let count = 0;
async function output(value: unknown) {
  if (!emit(value)) await new Promise<void>(resolve => process.stdout.once('drain', resolve));
}
async function collect(path: string, name: string): Promise<void> {
  let stat;
  try {stat = lstatSync(path);} catch(error) {if((error as {code?:string}).code==='ENOENT')return;throw error;}
  if (stat.isSymbolicLink()) {issues.push('日志含符号链接：' + name);return;}
  if (stat.isDirectory()) {
    for (const item of readdirSync(path).sort()) await collect(join(path,item), name + '/' + item);
    return;
  }
  if (!stat.isFile() || !(name.endsWith('.jsonl') || name==='claude-debug.log')) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before=fstatSync(fd);if(before.dev!==stat.dev || before.ino!==stat.ino || !before.isFile())throw Error('日志身份改变：'+name);
    await output({kind:'file',path:name,mode:before.mode&0o777,bytes:before.size});
    const hash=createHash('sha256'),buffer=Buffer.alloc(48*1024);let bytes=0;
    for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;){const part=buffer.subarray(0,n);hash.update(part);bytes+=n;await output({kind:'data',path:name,data:part.toString('base64')});}
    const after=fstatSync(fd);if(bytes!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)throw Error('日志收取时仍有写入：'+name);
    await output({kind:'end',path:name,bytes,sha256:hash.digest('hex')});count++;
  } finally {closeSync(fd);}
}
try {
  await collect('/task/.axi/logs','axi-session');
  await collect('/home/eval/.claude/projects','claude-session');
  await collect('/home/eval/claude-debug.log','claude-debug.log');
  await output({kind:'complete',files:count,issues});
  if(issues.length)process.exitCode=1;
} catch(error) {
  await output({kind:'failed',reason:String(error)});process.exitCode=1;
}
