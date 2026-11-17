import {readdirSync, lstatSync, openSync, readSync, closeSync, constants} from 'node:fs';
import {join} from 'node:path';

// 游标和聚合状态由宿主传入、保存；不把可信控制状态写入任务可修改的/tmp。
const previous:any=await Bun.stdin.json(),root='/task/.axi/logs';
const names=readdirSync(root).filter(x=>x.endsWith('.jsonl'));if(names.length!==1)throw Error('新会话必须有一份原生日志');
const path=join(root,names[0]!),stat=lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink())throw Error('原生日志不是普通文件');
const state:any=previous.offset===undefined?{name:names[0],dev:stat.dev,ino:stat.ino,offset:0,line:0,start:null,review:null,end:null,requests:0,lastBudget:null,firstApprovedAfterReview:null}:previous;
if(state.name!==names[0]||state.dev!==stat.dev||state.ino!==stat.ino||!Number.isSafeInteger(state.offset)||state.offset<0||stat.size<state.offset)throw Error('日志身份改变或发生截断');
const accept=(e:any,index:number)=>{
  if(e.version!==4)throw Error('候选日志版本不是4');
  state.sessionId??=e.sessionId;if(typeof e.sessionId!=='string'||e.sessionId!==state.sessionId)throw Error('日志会话身份不符');
  if(e.kind==='task_start'){state.start={index,time:e.time,...e.data};state.review=null;state.end=null;state.requests=0;state.lastBudget=null;state.firstApprovedAfterReview=null;}
  if(!state.start)return;
  if(e.data?.turn!==undefined&&e.data.turn!==state.start.turn)throw Error('原生日志轮次不符');
  if(e.kind==='request'){
    state.requests++;const b=e.data.budget;
    if(!b||b.requests!==state.requests||b.unlimited!==true||b.remaining!==null)throw Error('原生请求计数不连续或不是不限次数');
    state.lastBudget=b;
  }
  if(e.kind==='review_start'){
    if(state.review)throw Error('同一任务重复进入复核');state.review={index,time:e.time,...e.data};
  }
  if(e.kind==='permission'&&e.data.source==='user'&&e.data.allowed&&state.review&&!state.firstApprovedAfterReview)state.firstApprovedAfterReview={index,turn:e.data.turn,source:'user',allowed:true};
  if(e.kind==='task_end')state.end={index,time:e.time,...e.data};
};
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(64*1024);
let offset=state.offset,parts:Buffer[]=[],length=0;
try{
  for(let n;(n=readSync(fd,buffer,0,buffer.length,offset))>0;){
    let start=0;
    for(let i=0;i<n;i++)if(buffer[i]===10){
      parts.push(Buffer.from(buffer.subarray(start,i)));length+=i-start;
      if(length>64*1024*1024)throw Error('原生日志单条记录超过解析窗口');
      const bytes=Buffer.concat(parts,length),line=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(line.trim())accept(JSON.parse(line),state.line++);
      state.offset=offset+i+1;parts=[];length=0;start=i+1;
    }
    if(start<n){parts.push(Buffer.from(buffer.subarray(start,n)));length+=n-start;}
    if(length>64*1024*1024)throw Error('原生日志单条记录超过解析窗口');offset+=n;
  }
}finally{closeSync(fd);}
console.log(JSON.stringify({state,start:state.start,review:state.review,end:state.end,requestCount:state.requests,lastBudget:state.lastBudget,permissions:state.firstApprovedAfterReview?[state.firstApprovedAfterReview]:[]}));
