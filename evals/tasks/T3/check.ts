import { summarize } from "./parser.ts";
const actual = summarize("普通文字 [x]\n- [X] 完成\n- [ ] 待办\n- [~] 进行中\n");
if (JSON.stringify(actual) !== JSON.stringify({ todo: 1, doing: 1, done: 1 })) throw new Error(`解析结果错误：${JSON.stringify(actual)}`);
console.log("公开样例通过");
