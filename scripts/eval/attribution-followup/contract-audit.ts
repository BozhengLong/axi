import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {ROOT,save} from '../core.ts';
import {digestBytes} from '../stable/profile.ts';
import {profile} from './profile.ts';
import {STUDY,read} from './config.ts';
import {scopesFor} from './dependency-scope.ts';
const p=profile(),root='evals/specs/v1-attribution-followup-v1/',mapping=read(join(ROOT,root,'check-contract-map.json')),dependency=read(join(ROOT,root,'dependency-map.json')),rows:any[]=[];
const check=(id:string,passed:boolean)=>{rows.push({id,passed});if(!passed)throw Error('契约映射不完整:'+id)};
try{
 const ids=mapping.checks.map((x:any)=>x.id);check('unique-checks',new Set(ids).size===ids.length);
 for(const row of mapping.checks)check('fields:'+row.id,['publicContract','inputEvents','allowed','forbidden','errorOwnership','evidence','positive','negative','modules'].every(k=>row[k]!==undefined&&(typeof row[k]!=='string'||row[k].length>0)));
 for(const task of ['E','D']){const s=readFileSync(join(ROOT,'evals/v1-attribution-followup-v1/oracle',task+'-test.mjs.fixture'),'utf8');for(const match of s.matchAll(/test\('([ED]\d+) /g))check('contract:'+match[1],ids.includes(match[1]))}
 for(const c of read(join(ROOT,root,'reentrancy-cases.json')).cases)check('reentry:'+c.id,ids.includes(c.id));
 const semantics=read(join(ROOT,root,'waiting-cases.json'));for(const c of [...semantics.cases,...semantics.extensions])check('waiting:'+c.id,ids.includes(c.id));
 check('13+6-semantics',semantics.cases.length===13&&semantics.extensions.length===6);
 for(const [path,row]of Object.entries(dependency.files)as [string,any][]){
  const hash=digestBytes(readFileSync(join(ROOT,path))),repair=p.graderEpoch===1?read(join(STUDY,'grade-repair-decision.json')):undefined;
  check('dependency:'+path,(hash===row.sha256||repair?.measurementChanges?.[path]?.prior===row.sha256&&repair.measurementChanges[path].next===hash)&&JSON.stringify(row.modules)===JSON.stringify(scopesFor(path)));
 }
 check('waiting-local-scope',JSON.stringify(scopesFor('evals/v1-attribution-followup-v1/oracle/E-waiting.mjs.fixture'))===JSON.stringify(['Q','E']));
 check('parser-common-scope',scopesFor('scripts/eval/attribution-followup/status.ts').length===3);
}finally{save(join(STUDY,'contract-audit.json'),{complete:rows.every(x=>x.passed),mappedChecks:mapping.checks.length,rows,sourceHash:p.sourceHash});console.log(JSON.stringify({complete:rows.every(x=>x.passed),checks:rows.length,mappedChecks:mapping.checks.length}))}
