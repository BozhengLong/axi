import assert from 'node:assert/strict';
import memo from '../dist/index.js';
const rejection={reason:'backend write failure'},getterError={reason:'unexpected then access'};
const cache=new Map();
cache.set=()=>{const returned=Promise.reject(rejection);Object.defineProperty(returned,'then',{get(){throw getterError}});return returned};
const fn=memo(async()=>1,{cache});let caught;try{await fn('x')}catch(error){caught=error}
console.log(JSON.stringify({originalWriteError:caught===rejection,thenGetterError:caught===getterError}));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(caught,rejection,'preserve original cache.set rejection');
