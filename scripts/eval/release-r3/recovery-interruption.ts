import {mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {executeSubject} from './execute-subject.ts';
import {command,save} from './core.ts';
import {sha} from '../release-r2/source.ts';
import {taskPrompt} from '../release-r2/task-prompt.ts';
import {verifiedHostEnvironment} from '../release-r2/host-environment.ts';
import {snapshotFacility,verifyFacility} from './facility-snapshot.ts';

const [studyArg,label,taskId]=process.argv.slice(2);assert(studyArg&&label&&/^recovery-interrupt-[a-z0-9-]+$/.test(label)&&['health','U02'].includes(taskId!));
const study=resolve(studyArg);await verifiedHostEnvironment(study);
assert.equal(process.env.ANTHROPIC_API_KEY,'synthetic-local-key');assert.equal(process.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');
const out=join(study,label);mkdirSync(out);
const task=taskId==='health'?join(study,'health'):join(study,'tasks',taskId!);
const frozen=snapshotFacility(task,out);
const prompt=taskPrompt(task,taskId!);save(join(out,'prompt.json'),prompt);
// 合成首次claim剩健康约15秒、任务约30秒；原执行窗口保持。
const claim=JSON.parse((await command(['python3',join(import.meta.dir,'recovery-fixture.py'),study,label,taskId!,'v1'])).stdout);save(join(out,'controller-claim.json'),claim);
const control=async(action:string,payload:any)=>JSON.parse((await command(['python3',join(import.meta.dir,'controller-gateway.py')],JSON.stringify({study,action,mode:'mock',payload:{ledgerLabel:label,...payload}}))).stdout);
try{
 const x=await executeSubject(study,taskId!,'v1',label,out,{mock:[{content:[],stopReason:'end_turn',status:429,raw:'synthetic busy',headers:{'retry-after':'0'},repeat:100000}],prompt:prompt.text,claim:{mode:'mock',id:claim.id,ledgerLabel:label}});
 const sealed=await control('seal',{id:claim.id,output:label});save(join(out,'controller-seal.json'),sealed);assert.equal(sealed.claim.seal.termination,'deadline');
 const g=await command(['python3',join(import.meta.dir,'formal-grade.py'),study,claim.id,'--mock-ledger',label],undefined,true,taskId==='health'?305000:905000);save(join(out,'grade-process.json'),g);assert.equal(g.exitCode,0);
 const evidence=JSON.parse(readFileSync(join(out,'execution-evidence.json'),'utf8'));assert.equal(evidence.termination,'deadline');assert.equal(evidence.externalTerminalCause.status,429);
 const grade=JSON.parse(readFileSync(join(out,'final-grade/result.json'),'utf8'));assert(grade.protection.passed);assert.equal(grade.gradeStatus,'complete');assert.equal(evidence.permissions,0);
 const external=join(out,'external.json');save(external,{cause:evidence.externalTerminalCause,executionHash:evidence.executionHash});
 save(join(out,'review.json'),{artifactHash:sha(readFileSync(join(out,'final-snapshot.json'))),executionHash:evidence.executionHash,gradeHash:sha(readFileSync(join(out,'final-grade/result.json'))),reviewer:'mock deadline chain qualification',classification:'ENV_INTERRUPTED',externalEvidence:{path:label+'/external.json',sha256:sha(readFileSync(external))},protectionReviewed:true,confirmedH:false});
 const reviewed=await control('review',{id:claim.id,output:label});save(join(out,'controller-review.json'),reviewed);assert.equal(reviewed.classification,'ENV_INTERRUPTED');assert.equal(reviewed.paused.reason,'environment');
 save(join(out,'result.json'),{qualified:true,mockOnly:true,traceDirectory:x.traceDirectory,status:x.execution.status,termination:evidence.termination,classification:'ENV_INTERRUPTED',gradeStatus:grade.gradeStatus,claimAgeSeconds:taskId==='health'?165:1770});console.log(JSON.stringify({qualified:true,label}));
}finally{verifyFacility(frozen,out);}
