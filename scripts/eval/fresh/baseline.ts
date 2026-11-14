import {join} from 'node:path';
import {save,execute} from '../core.ts';
import {taskFiles,taskManifest} from '../v1/tasks.ts';
import {isolated} from '../v1/runtime.ts';
import {FRESH,IMAGE,tasks,preparationGate} from './settings.ts';
preparationGate();const rows=[];
for(const task of tasks){
 const r=await isolated(IMAGE,task,`fresh-baseline-${task}-${Date.now()}`,taskFiles(task));
 try{
  const logs=[];
  for(const [label,line]of taskManifest(task).commands){const result=await execute(r,['bash','-lc',line],undefined,true,300000);logs.push({label,command:line,...result});if(result.exitCode||result.timedOut){save(join(FRESH,'baseline-'+task+'.json'),logs);throw Error(task+'原测试或类型检查失败:'+label)}}
  save(join(FRESH,'baseline-'+task+'.json'),logs);rows.push({task,passed:true});console.log(JSON.stringify(rows.at(-1)));
 }finally{await r.close()}
}
save(join(FRESH,'baseline.json'),{complete:true,image:IMAGE,rows});
