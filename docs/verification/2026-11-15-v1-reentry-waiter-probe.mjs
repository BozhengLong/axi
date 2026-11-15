// 补充诊断：已形成身份、等待第一次删除的调用，被第二次删除失效后不能重新取得写资格。
// 只使用公开API及可控完成信号。它不改冻结机判；等待不终止由外部监督器单列不可判定。
import assert from 'node:assert/strict';
import * as api from './dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const first=deferred(),second=deferred(),startedFirst=deferred(),startedSecond=deferred(),oldResult=deferred(),oldEntered=deferred(),events=[];
const cache=new Map();let deletes=0;
cache.delete=async function(key){const index=++deletes;events.push('delete-start:'+index);(index===1?startedFirst:startedSecond).resolve();await(index===1?first:second).promise;Map.prototype.delete.call(this,key);events.push('delete-end:'+index)};
const fn=api.default(async(key,label)=>{events.push('fn:'+label);if(label==='waiting'){oldEntered.resolve();return oldResult.promise}return label},{cache});
assert.equal(typeof api.pMemoizeDelete,'function');
const d1=api.pMemoizeDelete(fn,'x');await startedFirst.promise;
const waiting=fn('x','waiting');const observedWaiting=waiting.then(value=>({value}),error=>({error}));
const d2=api.pMemoizeDelete(fn,'x');first.resolve();await d1;await startedSecond.promise;second.resolve();await d2;
await oldEntered.promise;
const fresh=fn('x','fresh');assert.notEqual(waiting,fresh);assert.equal(await fresh,'fresh');const before=cache.get('x');
oldResult.resolve('old');const old=await observedWaiting;const after=cache.get('x');
console.log(JSON.stringify({before,after,old,events}));
assert.deepEqual(old,{value:'old'});assert.equal(before,'fresh');assert.equal(after,'fresh','invalidated waiter must not regain write permission after later deletion');
