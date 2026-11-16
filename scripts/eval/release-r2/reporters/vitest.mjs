import {writeFileSync} from 'node:fs';
import {inspect} from 'node:util';

// 从Vitest原生任务结果取证；文件加载失败和真实测试断言分开。
const errorInfo = (error) => ({
  name: error?.name,
  code: error?.code,
  message: error?.message,
  stack: error?.stack,
  assertion: error?.name === 'AssertionError' &&
    (error?.code === 'ERR_ASSERTION' || Object.hasOwn(error, 'actual') || Object.hasOwn(error, 'expected')),
  actual: inspect(error?.actual, {depth: 5}),
  expected: inspect(error?.expected, {depth: 5}),
});
export default class EvidenceReporter {
  onFinished(files = [], errors = []) {
    if (!process.env.AXI_RESULT_PATH) throw Error('必须指定原生结果文件');
    const tests = [], suites = [];
    const visit = (task, path, ancestors) => {
      const row = {id: task.id, name: [...ancestors, task.name].join(' > '), file: path,
        mode: task.mode, state: task.result?.state ?? task.mode,
        durationMs: task.result?.duration ?? null,
        errors: (task.result?.errors ?? []).map(errorInfo)};
      if (task.type === 'test') tests.push(row);
      else {
        suites.push(row);
        for (const child of task.tasks ?? []) visit(child, path, [...ancestors, task.name]);
      }
    };
    for (const file of files) visit(file, file.filepath, []);
    const counts = Object.fromEntries(['pass', 'fail', 'skip', 'todo', 'run', 'only'].map(state => [state, tests.filter(t => t.state === state).length]));
    const report = {version: 1, framework: 'vitest-native', tests, suites,
      unhandled: errors.map(errorInfo), counts,
      assertionFailures: tests.filter(t => t.state === 'fail' && t.errors.some(e => e.assertion)).map(t => t.name)};
    writeFileSync(process.env.AXI_RESULT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
}
