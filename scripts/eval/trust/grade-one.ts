import {join} from 'node:path';
import {mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {grade} from './grade.ts';
import {assertMayGrade} from './grading-permission.ts';
import {read,assertGradingAllowed,tasks} from './config.ts';
import {profile} from './profile.ts';
import {GradingIndeterminate} from './status.ts';
import {verifyExecution,exclusive} from '../stable/execution.ts';
import {digestBytes} from '../stable/profile.ts';
if(process.argv[2]!=='--offline')throw Error('必须明确--offline');
const {run,target,revision,executionProfileHash,deadline,scope='final',qualification=false,gradeId}=JSON.parse(await Bun.stdin.text()),p=profile();
assertMayGrade(run,qualification);
if(typeof gradeId!=='string'||!/^trust-worker-\d+-[0-9a-f]{8}$/.test(gradeId))throw Error('评分所有权标识无效');
if(p.executionProfileHash!==executionProfileHash||p.graderRevision!==revision||!['final','checkpoint'].includes(scope))throw Error('评分版本或范围不符');
const seal=verifyExecution(run,executionProfileHash);if(!tasks.includes(seal.task))throw Error('当前仅支持已准备开发题');
const id=seal.id+(scope==='checkpoint'?'-checkpoint':''),directory=join(target,'grades',revision,id);mkdirSync(directory,{recursive:true,mode:0o700});exclusive(join(directory,'attempt.json'),{artifactHash:seal.artifactHash,scope,gradeId,started:new Date().toISOString(),deadline});let result:any;
try{
 const r=await grade(seal.task,gradeId,read(join(run,'initial-files.json')),read(join(run,scope==='checkpoint'?'review-checkpoint-files.json':'final-files.json')),directory,{executionStatus:scope==='checkpoint'?'completed':seal.executionStatus,git:read(join(run,scope==='checkpoint'?'review-checkpoint-git.json':'final-git.json')),initialGit:read(join(run,'initial-git.json')),deadline});
 result={gradeStatus:'complete',codePassed:r.codePassed,regressionPassed:r.regressionPassed,fullDeliveryPassed:null,failureChecks:r.checks.filter(c=>!c.pass).map(c=>c.id)};
}catch(error){result={gradeStatus:'indeterminate',codePassed:null,regressionPassed:null,fullDeliveryPassed:null,origin:error instanceof GradingIndeterminate?error.origin:'unknown_grader_error',error:String(error)}}
verifyExecution(run,executionProfileHash);const files:Record<string,string>={};
function walk(d:string,rel=''){for(const e of readdirSync(d,{withFileTypes:true})){const n=rel+e.name;if(e.isDirectory())walk(join(d,e.name),n+'/');else files[n]=digestBytes(readFileSync(join(d,e.name)))}}walk(directory);
exclusive(join(directory,'score.json'),{id,scope,checkpointKind:scope==='checkpoint'?read(join(run,'review-checkpoint.json')).review.checkpointKind:undefined,artifactHash:seal.artifactHash,executionProfileHash,graderRevision:revision,...result,files});
