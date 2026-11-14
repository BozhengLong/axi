import {reference} from './tasks.ts';
import {file,contents} from '../v1/tasks.ts';
// 合法的第三种清理路径：触发时靠原生once移除，其他结束路径显式移除。
export function nativeOnceReference(){
 const candidate=reference('V1-D'),source=contents(candidate['index.js']!);
 const before="options.signal?.removeEventListener('abort', onAbort);\n\t\t\tresolve({success, value});";
 if(source.split(before).length!==2)throw Error('原生once正例定位不唯一');
 candidate['index.js']=file(source.replace(before,"if (!options.signal?.aborted) options.signal?.removeEventListener('abort', onAbort);\n\t\t\tresolve({success, value});"));
 return candidate;
}
