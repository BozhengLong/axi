// 普通断言/编译错误可以判候选失败；执行器终止或来源不明的信号退出不能这样归因。
export function assertVerificationCompleted(result: {exitCode:number;timedOut?:boolean}, stage:string):void {
 if(result.timedOut || [137,143].includes(result.exitCode)) throw new Error(`verification_indeterminate:${stage}:exit=${result.exitCode}:timedOut=${result.timedOut===true}`);
}
