// 事后独立诊断：复制到待测Emittery产物根目录，用固定Node22运行。
import Emittery from './index.js';
const overflow=process.argv[2],seen=[];
const e=new Emittery();let ordinary=0;e.on('a',()=>{ordinary++});
const it=e.anyEvent({highWaterMark:1,overflow});
const bad=Promise.reject(new Error('handled-input'));bad.catch(()=>{});
await e.emit('a',overflow==='drop-oldest'?bad:1);
await e.emit('a',overflow==='drop-oldest'?2:bad);
// 在本轮事件循环结束前消费原库的两项；新库的丢弃项已无法取回。
const first=it.next().catch(error=>({error:error.message}));
const second=it.next().catch(error=>({error:error.message}));
await it.return();await Promise.all([first,second]);
await new Promise(resolve=>setTimeout(resolve,25));
console.log(JSON.stringify({overflow,ordinary,unhandled:seen}));
