import {digestBytes} from '../stable/profile.ts';
import {GradingIndeterminate} from './status.ts';

// D13的判定仍是实际监听器为零。原手工计数漏掉原生once移除，不能把实现手段当成泄漏。
// 只替换测量对象，不改输入、测试场景、assert语句或预期值。原始oracle文件保持冻结。
const before="listeners=new Set(),add=c.signal.addEventListener.bind(c.signal)";
const after="listeners={get size(){return trustNativeListeners(c.signal,'abort').length},add(){},delete(){}},add=c.signal.addEventListener.bind(c.signal)";
const prefix="import {getEventListeners as trustNativeListeners} from 'node:events';\n";
export function executableOracle(task:string,source:string){
 if(task!=='V1-D')return {source,measurement:null};
 if(source.split(before).length!==2||source.includes('trustNativeListeners'))throw new GradingIndeterminate('measurement_patch_mismatch','D13');
 const executable=prefix+source.replace(before,after);
 // 逆变换必须逐字还原，保证补丁没有顺带改变任何断言或场景。
 if(executable.slice(prefix.length).replace(after,before)!==source)throw new GradingIndeterminate('measurement_patch_scope','D13');
 return {source:executable,measurement:{id:'D13-native-once-v1',sourceSha256:digestBytes(Buffer.from(source)),executableSha256:digestBytes(Buffer.from(executable)),scope:'仅监听器数量测量；场景和断言原文不变',method:'node:events.getEventListeners',original:before,replacement:after}};
}
