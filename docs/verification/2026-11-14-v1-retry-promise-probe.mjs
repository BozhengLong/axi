import assert from 'node:assert/strict';
import retry from '../index.js';
const inputError=new Error('input failure'),getterError=new Error('unexpected then access');
const input=()=>{const returned=Promise.reject(inputError);Object.defineProperty(returned,'then',{get(){throw getterError}});return returned};
let caught;try{await retry(input,{attemptTimeout:Infinity,retries:0})}catch(error){caught=error}
console.log(JSON.stringify({originalInputError:caught===inputError,thenGetterError:caught===getterError}));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(caught,inputError,'preserve original input rejection without orphan rejection');
