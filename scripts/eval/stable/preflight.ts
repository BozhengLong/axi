import{join}from'node:path';
import{command}from'../core.ts';
import{exclusive}from'./execution.ts';
import{authorization,STUDY}from'./config.ts';
import{gates}from'./gates.ts';
if(process.argv[2]!=='--live')throw Error('需要 --live');
const a=authorization(),g=gates(false);
exclusive(join(STUDY,'initial-probes.claim'),{time:new Date().toISOString(),reservedStarts:3,maxRequestsEach:12,sourceHash:g.profile.sourceHash,deadline:a.deadline});
const r=await command(['bun','scripts/eval/v1/preflight.ts','--live'],undefined,true,15*60000);process.stdout.write(r.stdout);process.stderr.write(r.stderr);if(r.exitCode)process.exitCode=r.exitCode;
