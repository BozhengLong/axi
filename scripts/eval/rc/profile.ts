import {join} from 'node:path';
import {fingerprint} from '../complex/fingerprint.ts';
import {digest} from '../stable/profile.ts';
import {taskFiles,snapshotHash} from '../v1/tasks.ts';
import {authorization,STUDY,IMAGE,read} from './config.ts';
export function profile(){
 const a=authorization(),all=fingerprint(),origin=read(join(STUDY,'product-freeze.json'));
 const actual=Object.fromEntries(Object.entries(all.hashes).filter(([p])=>p.startsWith('src/')));
 if(digest(actual)!==origin.productHash)throw Error('候选产品或系统指令已改变');
 const inputs=Object.fromEntries((['V1-A','V1-B']as const).map(t=>[t,snapshotHash(taskFiles(t))]));
 const execution={image:IMAGE,productCommit:origin.commit,productHash:origin.productHash,node:'22.23.5',model:'claude-opus-5-5',effort:'medium',inputs,cpu:2,memoryGiB:4,runMs:1800000,generationRequests:50,sourceHash:all.sourceHash};
 return {...all,execution,executionProfileHash:digest(execution),graderRevision:digest({image:IMAGE,hashes:all.hashes,graderVersion:'rc-development-1'}),authorization:a};
}
