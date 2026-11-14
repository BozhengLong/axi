import assert from 'node:assert/strict';
import * as api from '../dist/index.js';
const cache=new Map(),receivers=[];let calls=0;
const fn=api.default(async()=>++calls,{cache,cacheKey:function([key]){receivers.push(this===undefined?'undefined':'object');return this===undefined?key:'wrong-key'}});
assert.equal(await fn('x'),1);assert.equal(await fn('y'),2);
assert.deepEqual(receivers,['undefined','undefined']);
if(typeof api.pMemoizeDelete==='function'){
 await api.pMemoizeDelete(fn,'x');const next=await fn('x');console.log(JSON.stringify({supported:true,receivers,next}));
 assert.equal(next,3,'delete must use the same cacheKey call context as memoization');assert.equal(await fn('y'),2);
}else console.log(JSON.stringify({supported:false,receivers,keys:[...cache.keys()]}));
