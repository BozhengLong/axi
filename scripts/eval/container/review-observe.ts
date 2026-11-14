import {readFileSync,readdirSync} from 'node:fs';
const logs=readdirSync('/task/.axi/logs').filter(p=>p.endsWith('.jsonl'));
if(logs.length!==1)throw Error('新会话必须只有一份原生日志');
const raw=readFileSync('/task/.axi/logs/'+logs[0],'utf8');
const events=raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(l=>JSON.parse(l));
const start=events.findLastIndex(e=>e.kind==='task_start');
const current=events.slice(start+1),pick=(kind:string)=>{const index=current.findLastIndex(e=>e.kind===kind);return index<0?null:{index:start+1+index,time:current[index].time,...current[index].data}};
const requests=current.filter(e=>e.kind==='request').map(e=>({callId:e.data.callId,attempt:e.data.attempt,budget:e.data.budget}));
console.log(JSON.stringify({start:start<0?null:{index:start,...events[start].data},review:pick('review_start'),end:pick('task_end'),requests,permissions:current.flatMap((e,i)=>e.kind==='permission'?[{index:start+1+i,...e.data}]:[])}));
