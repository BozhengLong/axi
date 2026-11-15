import {join} from 'node:path';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {ROOT} from '../core.ts';
import {fingerprint} from '../complex/fingerprint.ts';
import {digestBytes} from '../stable/profile.ts';
import {assertPreparation,STUDY} from './config.ts';
import {scopesFor} from './dependency-scope.ts';
assertPreparation();if(readdirSync(join(STUDY,'starts')).length)throw Error('真实启动后不能重建判定契约');
const root='evals/specs/v1-attribution-followup-v1/',path=join(ROOT,root,'contract-decision.json'),current=JSON.parse(readFileSync(path,'utf8'));
const all=fingerprint(),map={version:1,plan:'docs/18-v1-attribution-followup-plan.md',policy:'unknown or common file affects all; frozen scope cannot be narrowed by result',files:Object.fromEntries(Object.entries(all.hashes).filter(([name])=>name!==root+'dependency-map.json'&&name!==root+'contract-decision.json').map(([name,sha256])=>[name,{sha256,modules:scopesFor(name)}]))};
writeFileSync(join(ROOT,root,'dependency-map.json'),JSON.stringify(map,null,2)+'\n');
current.plan='docs/18-v1-attribution-followup-plan.md';current.semantics='docs/17-e09-waiter-semantics.md';current.severity.infrastructure='indeterminate; use frozen dependency scope, never ordinary task failure';
current.attributionCompletion={health:2,tasks:16,requiresAllTasksPass:false,requiresAllModulesTrusted:true};
for(const relative of ['waiting-contract.md','waiting-cases.json','check-contract-map.json','dependency-map.json'])current.definitions[root+relative]={};
current.definitions['evals/v1-attribution-followup-v1/oracle/E-waiting.mjs.fixture']={};
for(const name of Object.keys(current.definitions)){const bytes=readFileSync(join(ROOT,name));current.definitions[name]={definitionSource:bytes.toString(),sha256AtDefinition:digestBytes(bytes)}}
writeFileSync(path,JSON.stringify(current,null,2)+'\n');
console.log(JSON.stringify({definitions:Object.keys(current.definitions).length,dependencyFiles:Object.keys(map.files).length,liveStarts:0}));
