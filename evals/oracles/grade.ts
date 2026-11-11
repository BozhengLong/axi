import { docker, execute, snapshot, encodeFiles, type Snapshot, type Batch } from "../../scripts/eval/core.ts";
import type { Task } from "../../scripts/eval/tasks.ts";
import type { Execution } from "../../scripts/eval/adapters.ts";
import { isDeepStrictEqual } from "node:util";

export type Check = { name: string; pass: boolean; actual?: unknown; expected?: unknown };
const text = (s: Snapshot, name: string) => s[name]?.data ? Buffer.from(s[name]!.data!, "base64").toString("utf8") : undefined;
const equal = isDeepStrictEqual;
function counts(stdout: string) {
  return Object.fromEntries(stdout.trim().split(/\r?\n/).map(line => { const m = line.match(/^([^：:]+)[：:]\s*(.*?)\s*$/); return m ? [m[1], m[2]] : [line, ""]; }));
}

// 标准答案只在宿主控制器中比较，绝不写入运行生成代码的容器。
export async function grade(batch: Batch, id: string, task: Task, execution: Execution, final: Snapshot): Promise<{ pass: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, actual?: unknown, expected?: unknown) => checks.push({ name, pass, actual, expected });
  check("产品完成所有轮次", execution.status === "completed", execution.status);
  for (const [name, original] of Object.entries(task.files)) {
    if (task.writable.includes(name)) continue;
    check(`保留输入 ${name}`, text(final, name) === original && final[name]?.mode === 0o644, { type: final[name]?.type, mode: final[name]?.mode });
  }
  check("无符号链接或特殊文件", Object.values(final).every(f => ["file", "directory"].includes(f.type)));
  if (task.id === "T1") {
    check("只读任务没有新增文件", Object.keys(final).filter(k => final[k]!.type === "file").length === Object.keys(task.files).length);
    let actual: any;
    try { actual = JSON.parse(execution.turns.at(-1) ?? ""); } catch {}
    const data = Object.entries(task.files).filter(([name]) => name.startsWith("data/"));
    const expected = { fileCount: data.length, totalBytes: data.reduce((n, [, content]) => n + Buffer.byteLength(content), 0), project: "青松", owner: "林舟", deadline: "2026-12-01" };
    check("只读报告", !!actual && Object.entries(expected).every(([key, value]) => actual[key] === value), actual, expected);
    return { pass: checks.every(c => c.pass), checks };
  }
  if (task.id === "T2") {
    const first = execution.snapshots[0];
    check("第一轮未改文件", !!first && Object.entries(task.files).every(([p, v]) => text(first, p) === v) && Object.values(first).filter(v => v.type === "file").length === Object.keys(task.files).length);
  }
  const name = `axi-eval-${batch.id}-verify-${id}`;
  await docker(["run", "-d", "--name", name, "--label", `axi.eval.batch=${batch.id}`, "--network", "none", "--read-only", "--user", "0", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--security-opt", "no-new-privileges", "--cpus", "2", "--memory", "1g", "--pids-limit", "64", "--tmpfs", "/task:rw,nosuid,size=150m,mode=755", "--tmpfs", "/home/eval:rw,nosuid,size=32m,mode=755", "--tmpfs", "/tmp:rw,nosuid,size=64m,mode=1777", batch.image]);
  const runtime = { name };
  const seed = async (files: Record<string, string>) => execute(runtime, ["bun", "/opt/eval/files.ts", "seed"], encodeFiles(files));
  const run = async (args: string[]) => execute(runtime, args, undefined, true, 10000);
  try {
    await execute(runtime, ["bun", "/opt/eval/files.ts", "seed"], encodeFiles(Object.fromEntries(Object.entries(final).filter(([, f]) => f.type === "file").map(([p, f]) => [p, Buffer.from(f.data!, "base64")]))));
    if (task.id === "T2") {
      const cases: [string, Record<string, string>][] = [
        [task.files["tasks.md"]!, { "未开始": "3", "进行中": "1", "已完成": "2", "总数": "6", "完成率": "33.3%" }],
        ["# 空输入\r\n普通文字 [x]\r\n", { "未开始": "0", "进行中": "0", "已完成": "0", "总数": "0", "完成率": "0.0%" }],
        ["- [x] 完成\r\n- [~]\r\n- [ ] 等待\r\n- [x]again\r\n - [x] 缩进\r\n", { "未开始": "1", "进行中": "1", "已完成": "1", "总数": "3", "完成率": "33.3%" }],
      ];
      for (let i = 0; i < cases.length; i++) {
        const [input, expected] = cases[i]!; await seed({ "oracle-input.md": input });
        const r = await run(["bun", "run", "stats.ts", "oracle-input.md"]);
        check(`统计边界 ${i + 1}`, r.exitCode === 0 && equal(counts(r.stdout), expected), { exitCode: r.exitCode, stdout: r.stdout }, expected);
      }
      const second = execution.snapshots[1];
      if (second?.["stats.ts"]?.data) {
        await seed({ "stats.ts": text(second, "stats.ts")!, "oracle-input.md": task.files["tasks.md"]! });
        const r = await run(["bun", "run", "stats.ts", "oracle-input.md"]);
        check("第二轮初版实际可运行", r.exitCode === 0 && equal(counts(r.stdout), { "未开始": "3", "进行中": "1", "已完成": "2" }), r.stdout);
      } else check("第二轮生成了 stats.ts", false);
    }
    if (task.id === "T3") {
      const cases: [string, unknown][] = [
        ["", { todo: 0, doing: 0, done: 0 }],
        ["\ufeff- [X] 中文🙂\r\n- [ ] 待办\r\n- [~] 进行中\r\n普通 [x]\r\n", { todo: 1, doing: 1, done: 1 }],
        ["- [x]\n- [X]\n- [x]bad\n - [ ] 缩进\n- [xx] 错误\n- [~]\t进行中\n", { todo: 0, doing: 1, done: 2 }],
      ];
      for (let i = 0; i < cases.length; i++) {
        await seed({ "oracle-input.md": cases[i]![0] });
        const r = await run(["bun", "run", "parser.ts", "oracle-input.md"]); let actual;
        try { actual = JSON.parse(r.stdout); } catch {}
        check(`解析边界 ${i + 1}`, r.exitCode === 0 && equal(actual, cases[i]![1]), actual, cases[i]![1]);
      }
      const test = await run(["bun", "run", "check.ts"]); check("原有公开校验", test.exitCode === 0, test.stdout);
    }
    if (task.id === "T4") {
      const cases = [
        { input: { "a.json": '[{"id":"b","amount":2},{"id":"a","amount":1}]', "z.json": '[{"id":"b","amount":5},{"id":"c","amount":0}]' }, expected: { items: [{ id: "a", amount: 1 }, { id: "b", amount: 5 }, { id: "c", amount: 0 }], total: 6 } },
        { input: {}, expected: { items: [], total: 0 } },
        { input: { "a.json": '[{"id":"same","amount":1},{"id":"same","amount":7}]' }, expected: { items: [{ id: "same", amount: 7 }], total: 7 } },
        { input: { "a.json": JSON.stringify([{ id: "😀", amount: 2 }, { id: "\ue000", amount: 1 }]) }, expected: { items: [{ id: "\ue000", amount: 1 }, { id: "😀", amount: 2 }], total: 3 } },
      ];
      for (let i = 0; i < cases.length; i++) {
        await run(["mkdir", "-p", `verify-${i}`]);
        await seed(Object.fromEntries(Object.entries(cases[i]!.input).map(([p, v]) => [`verify-${i}/${p}`, v])));
        const r = await run(["bun", "run", "merge.ts", `verify-${i}`, `output-${i}.json`]);
        let actual; try { actual = JSON.parse((await run(["cat", `output-${i}.json`])).stdout); } catch {}
        check(`合并正常输入 ${i + 1}`, r.exitCode === 0 && equal(actual, cases[i]!.expected), actual, cases[i]!.expected);
      }
      for (const [i, invalid] of ['{bad', '[{"id":"","amount":1}]', '[{"id":"a","amount":-1}]', '[{"id":"a","amount":1.5}]', '[{"id":"a","amount":9007199254740991},{"id":"b","amount":1}]'].entries()) {
        await seed({ [`invalid-${i}/input.json`]: invalid, [`protected-${i}.json`]: "preserve-original\n" });
        const r = await run(["bun", "run", "merge.ts", `invalid-${i}`, `protected-${i}.json`]);
        const actual = (await run(["cat", `protected-${i}.json`])).stdout;
        check(`非法输入保持原输出 ${i + 1}`, r.exitCode !== 0 && r.stderr.length > 0 && actual === "preserve-original\n", { exitCode: r.exitCode, originalPreserved: actual === "preserve-original\n" });
      }
      const missing = await run(["bun", "run", "merge.ts", "missing-directory", "should-not-exist.json"]);
      const absent = await run(["test", "!", "-e", "should-not-exist.json"]);
      check("缺失目录不创建输出", missing.exitCode !== 0 && absent.exitCode === 0);
    }
  } catch (e) { check("验收环境完成", false, String(e)); }
  finally { await docker(["rm", "-f", name], undefined, true); }
  return { pass: checks.every(c => c.pass), checks };
}
