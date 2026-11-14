import {join} from 'node:path';
import {mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {grade} from '../v1/grade.ts';
import {verifyExecution,exclusive} from '../stable/execution.ts';
import {digestBytes} from '../stable/profile.ts';
import {read,IMAGE} from './config.ts';
import {profile} from './profile.ts';
import {extraChecks} from './quality.ts';
if(process.argv[2]!=='--offline')throw Error('需要 --offline');
const {run,target,executionProfileHash,revision,deadline}=JSON.parse(await Bun.stdin.text()),p=profile();
if(p.executionProfileHash!==executionProfileHash||p.graderRevision!==revision)throw Error('评分版本不符');
const seal=verifyExecution(run,executionProfileHash),directory=join(target,'grades',revision,seal.id);mkdirSync(directory,{recursive:true,mode:0o700});
exclusive(join(directory,'attempt.json'),{artifactHash:seal.artifactHash,revision,started:new Date().toISOString()});let result:any;
try{
 const seed=read(join(run,'initial-files.json')),candidate=read(join(run,'final-files.json'));
 const g=await grade(IMAGE,seal.task,'rc-'+Date.now(),seed,candidate,directory,{executionStatus:seal.executionStatus,git:read(join(run,'final-git.json')),initialGit:read(join(run,'initial-git.json')),deadline});
 const extra=await extraChecks(seal.task,seed,candidate,join(directory,'quality'),deadline);
 result={gradeStatus:'complete',codePassed:g.codePassed&&extra.passed,regressionPassed:g.regressionPassed,fullDeliveryPassed:null,failureChecks:[...g.checks.filter(c=>!c.pass).map(c=>c.id),...extra.checks.filter((c:any)=>!c.passed).map((c:any)=>c.id)],extra};
}catch(error){result={gradeStatus:'indeterminate',codePassed:null,regressionPassed:null,fullDeliveryPassed:null,error:String(error)}}
verifyExecution(run,executionProfileHash);
const files:Record<string,string>={};function walk(d:string,rel=''){for(const e of readdirSync(d,{withFileTypes:true})){const n=rel+e.name;if(e.isDirectory())walk(join(d,e.name),n+'/');else files[n]=digestBytes(readFileSync(join(d,e.name)))}}walk(directory);
exclusive(join(directory,'score.json'),{id:seal.id,artifactHash:seal.artifactHash,executionProfileHash,graderRevision:revision,...result,files});
