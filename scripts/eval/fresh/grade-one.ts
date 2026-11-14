import {join} from 'node:path';
import {mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {grade} from './grade.ts';
import {read,tasks} from './settings.ts';
import {profile} from './profile.ts';
import {verifyExecution,exclusive} from '../stable/execution.ts';
import {digestBytes} from '../stable/profile.ts';
if(process.argv[2]!=='--offline')throw Error('需要明确 --offline');
const {run,target,revision,executionProfileHash,deadline,scope='final'}=JSON.parse(await Bun.stdin.text()),p=profile();
if(p.executionProfileHash!==executionProfileHash||p.graderRevision!==revision||!['final','checkpoint'].includes(scope))throw Error('评分版本或范围不符');
const seal=verifyExecution(run,executionProfileHash);if(!tasks.includes(seal.task))throw Error('非本轮新题');
const id=seal.id+(scope==='checkpoint'?'-checkpoint':''),directory=join(target,'grades',revision,id);mkdirSync(directory,{recursive:true,mode:0o700});exclusive(join(directory,'attempt.json'),{artifactHash:seal.artifactHash,scope,started:new Date().toISOString()});let result:any;
try{
 const seed=read(join(run,'initial-files.json')),candidate=read(join(run,scope==='checkpoint'?'review-checkpoint-files.json':'final-files.json'));
 const r=await grade(seal.task,'fresh-'+Date.now(),seed,candidate,directory,{executionStatus:scope==='checkpoint'?'completed':seal.executionStatus,git:read(join(run,scope==='checkpoint'?'review-checkpoint-git.json':'final-git.json')),initialGit:read(join(run,'initial-git.json')),deadline});
 result={gradeStatus:'complete',codePassed:r.codePassed,regressionPassed:r.regressionPassed,fullDeliveryPassed:null,failureChecks:r.checks.filter(c=>!c.pass).map(c=>c.id)};
}catch(error){result={gradeStatus:'indeterminate',codePassed:null,regressionPassed:null,fullDeliveryPassed:null,error:String(error)}}
verifyExecution(run,executionProfileHash);const files:Record<string,string>={};function walk(d:string,rel=''){for(const e of readdirSync(d,{withFileTypes:true})){const n=rel+e.name;if(e.isDirectory())walk(join(d,e.name),n+'/');else files[n]=digestBytes(readFileSync(join(d,e.name)))}}walk(directory);
exclusive(join(directory,'score.json'),{id,scope,checkpointKind:scope==='checkpoint'?read(join(run,'review-checkpoint.json')).review.checkpointKind:undefined,artifactHash:seal.artifactHash,executionProfileHash,graderRevision:revision,...result,files});
