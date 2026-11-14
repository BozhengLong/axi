import {join} from 'node:path';
import {save,execute} from '../core.ts';
import {taskManifest} from '../v1/tasks.ts';
import {isolated} from '../v1/runtime.ts';
import {reference} from './tasks.ts';
import {FRESH,IMAGE,tasks,preparationGate} from './settings.ts';
preparationGate();
for(const task of tasks){
 const r=await isolated(IMAGE,task,`fresh-reference-upstream-${task}-${Date.now()}`,reference(task,false));
 try{
  const logs=[];
  for(const [label,line]of taskManifest(task).commands){const result=await execute(r,['bash','-lc',line],undefined,true,300000);logs.push({label,command:line,...result});if(result.exitCode||result.timedOut){save(join(FRESH,'reference-upstream-'+task+'.json'),logs);throw Error(task+'参考未保持原测试:'+label)}}
  save(join(FRESH,'reference-upstream-'+task+'.json'),logs);console.log(JSON.stringify({task,passed:true}));
 }finally{await r.close()}
}
