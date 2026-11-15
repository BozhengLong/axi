import {digestBytes} from '../stable/profile.ts';
// 新研究直接固定实际执行脚本。旧研究的测量变换与成绩不变。
export function executableOracle(task:string,source:string){return {source,measurement:{id:'reentry-direct-v1',sourceSha256:digestBytes(Buffer.from(source)),executableSha256:digestBytes(Buffer.from(source)),scope:'新契约固定脚本，无运行时文本改写'}}}
