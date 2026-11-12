import{join}from'node:path';
import{read,STUDY,IMAGE}from'./config.ts';
import{profile}from'./profile.ts';
export function gates(requireLive=true){
 const p=profile();
 const specs:[string,string,number][]=[['compatibility-latest.json','results',10],['stability-latest.json','results',320],['calibration-latest.json','results',14],['c7-replay-latest.json','results',2],['pipeline-latest.json','results',24],['smoke-latest.json','checks',9],['transport-smoke-latest.json','results',7],['recovery-checks-latest.json','results',6]];
 const reports:any={};
 for(const[name,key,count]of specs){const r=read(join(STUDY,name));if(!r.complete||r.image!==IMAGE||r.sourceHash!==p.sourceHash||r[key].length!==count||r[key].some((x:any)=>!x.passed))throw Error('门槛未通过或源码不符:'+name);reports[name]=r.directory??r.batch;}
 const stability=read(join(STUDY,'stability-latest.json'));if(Object.entries(p.inputs).some(([t,h])=>stability.inputs[t]!==h))throw Error('稳定性输入不符');
 if(requireLive){const r=read(join(STUDY,'preflight-latest.json'));if(!r.complete||r.image!==IMAGE||r.sourceHash!==p.sourceHash||r.checks.some((x:any)=>!x.pass))throw Error('真实前置未通过');reports.preflight=r.directory;}
 return {profile:p,reports};
}
