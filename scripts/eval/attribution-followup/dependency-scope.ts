import type {ModuleId} from './modules.ts';
// 运行前固定；只有本研究的任务材料可局部隔离。共用解析/封存/控制默认影响全部。
export function scopesFor(path:string):ModuleId[]{
 const prefix=['evals/v1-attribution-followup-v1/','evals/specs/v1-attribution-followup-v1/'].find(p=>path.startsWith(p));
 if(!prefix)return ['Q','D','E'];
 const local=path.slice(prefix.length);
 if(/(^|\/)D(?:-|\/)/.test(local))return ['D'];
 if(/^assistance(?:\.|\/)/.test(local))return ['Q'];
 if(/(^|\/)E(?:-|\/)/.test(local)||/^(waiting-|reentrancy-)/.test(local))return ['Q','E'];
 return ['Q','D','E'];
}
export function moduleFor(task:string):ModuleId{return task==='V1-D'?'D':task==='V1-E'?'E':'Q'}
