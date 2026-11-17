import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';

const [studyArg,label]=process.argv.slice(2);
if(!studyArg||!label||!/^bundle-[0-9]+$/.test(label))throw Error('需要研究目录及新的bundle编号');
const out=join(resolve(studyArg),label);mkdirSync(out);
const rows=[];
for(const [area,file]of [['relay','relay.ts'],['task','native-export.ts'],['task','review-observe.ts']]as const){
  const built=await Bun.build({entrypoints:[join(import.meta.dir,file)],outdir:join(out,area),target:'bun',format:'esm',minify:false});
  if(!built.success)throw Error(built.logs.map(String).join('\n'));
  for(const item of built.outputs){const bytes=readFileSync(item.path);rows.push({path:item.path.slice(out.length+1),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
}
writeFileSync(join(out,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),bun:Bun.version,files:rows,scope:'R3代理和任务侧观察/原生日志导出；不包含评分或参考实现'},null,2)+'\n');
console.log(JSON.stringify({out,files:rows.length}));
