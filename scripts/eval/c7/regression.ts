import { execute, type Snapshot } from "../core.ts";
import { isolated } from "./runtime.ts";
import { clean, newTests, newTestFiles } from "./tasks.ts";
import type { TaskId } from "./settings.ts";

export type TestRun = { exitCode: number; stdout: string; stderr: string; total: number; passed: number; failed: number; skipped: number; assertionFailure: boolean; report: unknown };
export function parseTestRun(task: TaskId, result: { exitCode: number; stdout: string; stderr: string }, reportText: string): TestRun {
  let total = 0, passed = 0, failed = 0, skipped = 0, assertionFailure = false, report: unknown = reportText;
  if (task === "C7-L") {
    try {
      const j = JSON.parse(reportText); report = j;
      total = j.numTotalTests ?? 0; passed = j.numPassedTests ?? 0; failed = j.numFailedTests ?? 0; skipped = (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0);
      const messages = (j.testResults ?? []).flatMap((s: any) => (s.assertionResults ?? []).filter((a: any) => a.status === "failed").flatMap((a: any) => a.failureMessages ?? []));
      assertionFailure = messages.some((m: string) => /expect\(|AssertionError|Expected:/.test(m));
    } catch { /* 缺失或不可解析的报告不是有效测试。 */ }
  } else {
    // 非贪婪地结束开标签，避免把自闭合的通过项吞进后面的失败项。
    const cases = [...reportText.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map(m => m[0]);
    total = cases.length; failed = cases.filter(c => /<failure\b/.test(c)).length; skipped = cases.filter(c => /<skipped\b/.test(c)).length;
    const root = reportText.match(/<testsuites\b[^>]*>/)?.[0];
    if (root) {
      const attributes = Object.fromEntries([...root.matchAll(/\b(tests|failures|skipped)="(\d+)"/g)].map(m => [m[1]!, Number(m[2])]));
      if ((attributes.tests !== undefined && attributes.tests !== total) || (attributes.failures !== undefined && attributes.failures !== failed) || (attributes.skipped !== undefined && attributes.skipped !== skipped)) throw new Error("JUnit 报告计数不一致：验收器不可判定，不能算候选失败");
    }
    passed = total - failed - skipped;
    assertionFailure = failed > 0 && /expect\(|AssertionError|Expected:/.test(result.stderr + result.stdout + reportText);
  }
  return { ...result, total, passed, failed, skipped, assertionFailure, report };
}
export const regressionValid = (old: TestRun, current: TestRun) => current.exitCode === 0 && current.total > 0 && current.passed === current.total && current.skipped === 0 && old.total === current.total && old.failed > 0 && old.assertionFailure && old.skipped === 0 && old.exitCode !== 0;

export async function runTests(name: string, task: TaskId, paths: string[]): Promise<TestRun> {
  const reportPath = task === "C7-L" ? "/tmp/c7-jest.json" : "/tmp/c7-junit.xml";
  const args = task === "C7-L"
    ? ["pnpm", "--filter", "listr2", "run", "test", "--runInBand", "--runTestsByPath", ...paths.map(p => p.replace(/^packages\/listr2\//, "")), "--json", "--outputFile", reportPath]
    : ["bun", "test", ...paths.map(p => "./" + p), "--reporter=junit", "--reporter-outfile=" + reportPath];
  const result = await execute({ name }, args, undefined, true, 120000);
  const report = await execute({ name }, ["cat", reportPath], undefined, true);
  return parseTestRun(task, result, report.stdout);
}
export async function replay(image: string, task: TaskId, id: string, seed: Snapshot, candidate: Snapshot, currentName: string, checkDeadline: () => void) {
  const paths = newTests(task, seed, candidate), added = newTestFiles(task, seed, candidate);
  if (!paths.length) return { valid: false, reason: "没有新增独立回归测试", paths, helperFiles: Object.keys(added) };
  const current = await runTests(currentName, task, paths); checkDeadline();
  const old = await isolated(image, task, `${id}-replay-old`, { ...clean(seed), ...added });
  try {
    const build = task === "C7-L" ? await execute(old, ["pnpm", "run", "build"], undefined, true, 180000) : undefined;
    if (build?.exitCode) return { valid: false, reason: "旧代码测试环境未构建成功", paths, build, current, helperFiles: Object.keys(added) };
    const previous = await runTests(old.name, task, paths); checkDeadline();
    return { valid: regressionValid(previous, current), paths, helperFiles: Object.keys(added), previous, current, semanticReview: "pending" };
  } finally { await old.close(); }
}
