import { expect,test } from "bun:test";
import { CheckAttempts } from "../src/tools/check-attempts.ts";
import { runBash } from "../src/tools/bash.ts";

test("外层0、缺失入口、有效重试及样例数字保持各自含义", async () => {
  const book=new CheckAttempts();
  const run=async(id:string,command:string)=>{
    const r=await runBash({command,timeoutMs:5000},process.cwd(),new AbortController().signal);
    return book.record(id,command,r.content,r.exitCode,r.outcome);
  };
  const first=await run("one","axi_fixture_nonexistent_check; echo check=$?");
  expect(first.shellExit).toBe(0);
  expect(first.reported).toEqual([{label:"check",value:127}]);
  expect(first.excerpt.join(" ")).toContain("command not found");
  const noise=await run("noise","printf 'check=127\\n'");
  expect(noise.reported).toEqual([]);
  const again=await run("two","false | cat; echo \"verify=\${PIPESTATUS[0]}\"");
  expect(again.reported).toEqual([{label:"verify",value:1}]);
  const last=await run("three","true; rc=$?; printf 'check=%s\\n' \"$rc\"");
  expect(last.reported).toEqual([{label:"check",value:0}]);
  expect(book.render()).toContain('"toolId":"one"');
});
test("未取得子进程状态时留空，摘要明确省略且保留先前异常",()=>{
  const book=new CheckAttempts(); book.record("bad","missing","退出码：127\nmissing: command not found",127,"completed");
  for(let i=0;i<16;i++) expect(book.record("x"+i,"tool >/dev/null 2>&1; echo done","退出码：0\ndone",0,"completed").reported).toEqual([]);
  const s=book.render();expect(s).toContain('"omitted":12');expect(s).toContain('"toolId":"bad"');
});
