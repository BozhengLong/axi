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

// 先执行操作，只有尚未同步结束才创建计时器。同步抛错不需要额外计时器。
export function lazyTimerReference(){
 const candidate=nativeOnceReference(),source=contents(candidate['index.js']!);
 const start=source.indexOf('\t\tif (Number.isFinite(options.attemptTimeout)) {',source.indexOf('function runTimedAttempt'));
 const operationStart=source.indexOf('\t\t// 观察原生Promise',start),operationEnd=source.indexOf('\n\t});\n}',operationStart);
 if(start<0||operationStart<0||operationEnd<0)throw Error('延迟计时正例定位失败');
 const timer=source.slice(start,operationStart).replace('if (Number.isFinite(options.attemptTimeout))','if (!settled && Number.isFinite(options.attemptTimeout))').replace('}, options.attemptTimeout);','}, Math.max(0, options.attemptTimeout - (performance.now() - started)));');
 candidate['index.js']=file(source.slice(0,start)+'\t\tconst started = performance.now();\n'+source.slice(operationStart,operationEnd)+'\n'+timer+source.slice(operationEnd));
 return candidate;
}
