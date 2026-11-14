import {join} from 'node:path';
import {readFileSync,copyFileSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {ROOT,save} from '../core.ts';
import {file,contents,snapshotHash} from '../v1/tasks.ts';
import {STUDY,HISTORY,tasks,read,authorization} from './config.ts';
authorization();
for(const task of tasks){
 const id=task.slice(-1),old=join(HISTORY,'tasks',id),dest=join(STUDY,'tasks',id);mkdirSync(dest,{recursive:true,mode:0o700});
 if(existsSync(join(dest,'input.json')))throw Error('不覆盖已固定开发输入');
 const seed=read(join(old,'input.json')),prior=read(join(old,'manifest.json'));
 if(snapshotHash(seed)!==prior.inputSha256)throw Error('历史输入已改变');
 for(const name of ['dependencies.json','package-lock.json'])copyFileSync(join(old,name),join(dest,name));
 seed['eval/brief.md']=file(readFileSync(join(ROOT,`evals/specs/v1-trust-dev-v1/${id}/brief.md`),'utf8'));
 seed['eval/environment.md']=file(contents(seed['eval/environment.md'])+'\n评分规则：最终与检查点共用15分钟（最后5秒清理）；没有测试文件级10秒上限。运行器、进程监督器或总预算中断时单列不可判定。E的.tsimp为tsimp自动缓存，原始快照保留，评分副本会重建；不得在其中放生产实现。新旧回放使用同一份新增测试，须执行完相同测试集，不能把取消、跳过或导入错误当作有效行为失败。\n');
 save(join(dest,'input.json'),seed);save(join(dest,'manifest.json'),{...prior,revision:1,study:'v1-trust-20261115',priorInputSha256:prior.inputSha256,inputSha256:snapshotHash(seed),upstreamTestCount:task==='V1-E'?90:132,oracleCount:22,cachePaths:task==='V1-E'?['.tsimp']:[],grading:{totalMs:900000,cleanupReserveMs:5000,outerOracleCaseMs:6000,defaultNodeDiagnosticMs:3000,fileTimeout:null},created:new Date().toISOString()});
 console.log(JSON.stringify({task,inputSha256:snapshotHash(seed),dependencyVolume:prior.dependencyVolume}));
}
