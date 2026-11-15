import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {command,save,ROOT} from '../core.ts';
import {contents,taskFiles,taskManifest,snapshotHash} from '../v1/tasks.ts';
import {digestBytes} from '../stable/profile.ts';
import {STUDY,HISTORY,authorization,read,tasks} from './config.ts';
const a=authorization(),checks:any[]=[];
function check(name:string,passed:boolean,evidence:unknown){checks.push({name,passed,evidence});if(!passed)throw Error('输入资格失败:'+name)}
try{
 const names=(await command(['git','ls-tree','-r','--name-only',a.baselineV1Commit,'src'])).stdout.trim().split('\n');
 const hashes:Record<string,string>={};
 for(const name of names){const expected=(await command(['git','show',a.baselineV1Commit+':'+name])).stdout,actual=readFileSync(join(STUDY,'current',name),'utf8');check('0330626:'+name,actual===expected,null);hashes[name]=digestBytes(Buffer.from(actual))}
 for(const task of tasks){const old=read(join(HISTORY,'tasks',task.slice(-1),'input.json'));check(task+':unchanged-public-input',snapshotHash(old)===snapshotHash(taskFiles(task)),snapshotHash(old))}
 const u=taskFiles('V1-U'),q=taskFiles('V1-Q'),declaration=read(join(STUDY,'input-declaration.json'));
 const differences=Object.keys({...u,...q}).filter(p=>JSON.stringify(u[p])!==JSON.stringify(q[p])).sort();
 check('assistance-only-input-difference',JSON.stringify(differences)===JSON.stringify(declaration.Q.allowedDifferences),differences);
 const mutation=declaration.Q.mutation,ref=readFileSync(join(ROOT,'evals/v1-attribution-dev-v1/reference/E-index.ts.fixture'),'utf8');
 check('single-declared-production-mutation',contents(u['index.ts']!)===ref.replace(mutation.before,mutation.after)&&contents(q['index.ts']!)===contents(u['index.ts']!),mutation);
 check('repair-has-no-reference-tests',Object.keys(u).every(p=>!p.startsWith('eval-tests/'))&&Object.keys(q).every(p=>!p.startsWith('eval-tests/')),null);
 check('same-dependencies',taskManifest('V1-U').dependencyVolume===taskManifest('V1-E').dependencyVolume&&taskManifest('V1-Q').dependencyVolume===taskManifest('V1-E').dependencyVolume,null);
 save(join(STUDY,'subject-source.json'),{commit:a.baselineV1Commit,hashes});
}finally{save(join(STUDY,'input-audit.json'),{complete:checks.length>0&&checks.every(x=>x.passed),checks});console.log(JSON.stringify({complete:checks.every(x=>x.passed),checks:checks.length}))}
