import{gradeArtifact}from'./grading.ts';
if(process.argv[2]!=='--offline')throw Error('需要 --offline');
const x=JSON.parse(await Bun.stdin.text());
const result=await gradeArtifact(x.run,x.target,x.revision,x.executionProfileHash,{deadline:x.deadline});
console.log(JSON.stringify({scorePath:result.scorePath,gradeStatus:result.gradeStatus}));
