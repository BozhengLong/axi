import {mkdirSync, openSync, closeSync, writeSync, readSync, lstatSync, readdirSync, constants, chmodSync} from 'node:fs';
import {resolve, join, dirname, relative} from 'node:path';
import {createHash} from 'node:crypto';
import {ChunkWriter, verifyChunks} from './chunks.ts';
import {JsonLines} from './json-lines.ts';
import {execArgs, save, type Runtime, type Batch} from '../core.ts';

export class IOTrace {
  private writer:ChunkWriter;
  private started=performance.now();
  private failed=false;
  // PTY回调异常不一定结束Bun进程。记住失败，主循环才能停止CLI。
  get truncated(){return this.failed;}
  constructor(readonly directory:string,agent:string,args:string[]){
    this.writer=new ChunkWriter(join(directory,'io.chunks'));
    this.event('start',{agent,args,version:3});
  }
  event(kind:string,data:unknown){
    try{
      this.writer.write(JSON.stringify({time:new Date().toISOString(),elapsedMs:performance.now()-this.started,kind,data})+'\n');
      if(kind==='finish')this.writer.finish();
    }catch(error){this.failed=true;throw error;}
  }
  bytes(kind:string,bytes:Uint8Array|string){const b=Buffer.from(bytes);this.event(kind,{encoding:'base64',bytes:b.byteLength,data:b.toString('base64')});}
}

export function fileHash(path:string):string{
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);
  try{for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,n));}finally{closeSync(fd);}
  return hash.digest('hex');
}

export function readEvents(directory:string,accept:(event:any)=>void){
  const manifest=verifyChunks(directory),parser=new JsonLines(accept),buffer=Buffer.alloc(64*1024);
  for(const part of manifest.chunks){const fd=openSync(join(directory,part.name),constants.O_RDONLY|constants.O_NOFOLLOW);try{for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;)parser.write(buffer.subarray(0,n));}finally{closeSync(fd);}}
  parser.finish();
}

export async function collectNativeTrace(runtime:Runtime){
  const root=join(runtime.directory,'native');mkdirSync(root,{mode:0o700});
  let fd:number|undefined,current='',expected=0,size=0,hash=createHash('sha256'),complete=false;
  const files:{path:string;bytes:number;sha256:string}[]=[],issues:string[]=[];
  const parser=new JsonLines(e=>{
    if(complete)throw Error('日志完成后仍有导出事件');
    if(e.kind==='file'){
      if(fd!==undefined || typeof e.path!=='string' || !/^(axi-session\/|claude-session\/|claude-debug\.log$)/.test(e.path) || e.path.split('/').some((p:string)=>!p||p==='.'||p==='..'))throw Error('日志导出路径或顺序无效');
      current=e.path;expected=e.bytes;size=0;hash=createHash('sha256');const target=resolve(root,current);
      if(!target.startsWith(root+'/'))throw Error('日志路径越界');mkdirSync(dirname(target),{recursive:true,mode:0o700});
      fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    }else if(e.kind==='data'){
      if(fd===undefined || e.path!==current || typeof e.data!=='string')throw Error('日志块没有匹配文件');
      const bytes=Buffer.from(e.data,'base64');for(let at=0;at<bytes.length;){const n=writeSync(fd,bytes,at,bytes.length-at);if(n<=0)throw Error('日志导出写入无进展');at+=n;}
      size+=bytes.length;hash.update(bytes);
    }else if(e.kind==='end'){
      if(fd===undefined || e.path!==current || size!==expected || size!==e.bytes || hash.digest('hex')!==e.sha256)throw Error('原生日志完整性不符');
      closeSync(fd);fd=undefined;files.push({path:current,bytes:size,sha256:e.sha256});
    }else if(e.kind==='complete'){
      if(fd!==undefined || e.files!==files.length || !Array.isArray(e.issues))throw Error('日志完成记录无效');complete=true;issues.push(...e.issues);
    }else throw Error('日志导出失败或未知事件');
  },256*1024);
  const child=Bun.spawn(execArgs(runtime,['bun','/opt/eval-r3/native-export.js']),{stdout:'pipe',stderr:'pipe'});
  const stderr=new Response(child.stderr).text();
  try{
    for await(const chunk of child.stdout)parser.write(chunk);parser.finish();
    const code=await child.exited,err=await stderr;if(code!==0||!complete||err)throw Error('原生日志导出进程未完整结束：'+err);
  }catch(error){issues.push(String(error));child.kill('SIGKILL');await child.exited;await stderr;}
  finally{if(fd!==undefined)closeSync(fd);}
  save(join(root,'manifest.json'),{status:complete&&!issues.length?'collected':'failed',issues,files});
}

export function finalizeTrace(batch:Batch,runtime:Runtime){
  const files:{path:string;bytes:number;sha256:string}[]=[];
  const walk=(directory:string)=>{for(const name of readdirSync(directory).sort()){
    if(directory===runtime.directory && ['trace-manifest.json','TRACE.md'].includes(name))continue;
    const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('证据含符号链接');
    if(stat.isDirectory())walk(path);else if(stat.isFile())files.push({path:relative(runtime.directory,path),bytes:stat.size,sha256:fileHash(path)});else throw Error('证据含特殊文件');
  }};
  const relay=join(batch.directory,'relay',runtime.id+'.chunks');verifyChunks(relay);verifyChunks(join(runtime.directory,'io.chunks'));
  walk(runtime.directory);walk(relay);
  let agent='',start=0,finish=0;
  readEvents(join(runtime.directory,'io.chunks'),e=>{if(e.kind==='start'){start++;agent=e.data.agent;}if(e.kind==='finish')finish++;if(e.kind==='truncated'||e.kind==='stderr_read_error')throw Error('终端证据不完整');});
  if(start!==1||finish!==1)throw Error('CLI生命周期不完整');
  const native=JSON.parse(require('node:fs').readFileSync(join(runtime.directory,'native/manifest.json'),'utf8'));
  if(native.status!=='collected'||!native.files.some((f:any)=>f.path.startsWith(agent==='claude'?'claude-session/':'axi-session/')))throw Error('原生会话证据缺失');
  if(agent==='claude'&&!native.files.some((f:any)=>f.path==='claude-debug.log'))throw Error('Claude调试记录缺失');
  const result={version:3,run:runtime.id,agent,status:'complete_observable',missing:[],files};
  save(join(runtime.directory,'trace-manifest.json'),result);return result;
}
