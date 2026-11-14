import {join} from 'node:path';
import {save,docker} from '../core.ts';
import {taskFiles,file} from '../v1/tasks.ts';
import {grade} from './grade.ts';
import {reference} from './tasks.ts';
import {FRESH} from './settings.ts';
const mode=process.argv[2];if(!['cache','unknown'].includes(mode??''))throw Error('需要cache或unknown');
const id='fresh-init-'+Date.now(),candidate=reference('V1-E'),directory=join(FRESH,id),start=Date.now();let passed=false,error:string|undefined;
const prefix=mode==='cache'?'.tsimp':'unexpected-runtime';
candidate[prefix+'/daemon/socket']={type:'special',mode:0o755};
candidate[prefix+'/daemon/pid']=file('12345\n');
try{
 const result=await grade('V1-E',id,taskFiles('V1-E'),candidate,directory);
 passed=mode==='cache'&&result.codePassed&&result.regressionPassed;
}catch(e){error=String(e);passed=mode==='unknown'&&error.includes('拒绝特殊文件')&&Date.now()-start<10000}
const resources=[];
for(const suffix of ['current','old']){const r=await docker(['volume','inspect','axi-v1-'+id+'-'+suffix],undefined,true);resources.push({suffix,removed:r.exitCode!==0})}
passed=passed&&resources.every(r=>r.removed);
save(join(directory,'result.json'),{mode,passed,error,resources,elapsedMs:Date.now()-start});
console.log(JSON.stringify({mode,passed,directory}));if(!passed)throw Error('评分初始化检查失败');
