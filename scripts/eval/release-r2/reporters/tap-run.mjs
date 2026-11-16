// 用题目固定的 tap-parser 读取原生 TAP。命令退出与解析结果分别留证。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const require = createRequire('/task/package.json');
const { Parser } = require('tap-parser');
const parser = new Parser();
const points = [], completed = [], parserErrors = [];
function attach(current) {
  current.on('assert', result => points.push(result));
  current.on('child', attach);
  current.on('complete', result => completed.push({ name: current.fullname, result }));
  current.on('error', error => parserErrors.push({ name: error.name, message: error.message }));
}
attach(parser);
const [command, ...args] = process.argv.slice(2);
if (!command || !process.env.AXI_RESULT_PATH) throw new Error('command and AXI_RESULT_PATH required');
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.on('data', data => { process.stdout.write(data); parser.write(data); });
let launchError;
child.on('error', error => { launchError = { name: error.name, message: error.message }; });
child.on('close', (code, signal) => {
  parser.end();
  // Result 的 closingTestPoint 在完整解析后才读取，不把子测试收尾重复算成行为断言。
  const selected = points.map(p => ({ name: p.fullname, ok: p.ok, closing: p.closingTestPoint,
    skip: p.skip, todo: p.todo, tapError: p.tapError }));
  const leaves = selected.filter(p => !p.closing);
  const root = completed.find(p => !p.name)?.result;
  const result = { version: 1, framework: 'tap-parser', command: [command, ...args], code, signal,
    launchError, parserErrors, root, points: selected, suites: completed,
    counts: { all: selected.length, leaves: leaves.length, failedLeaves: leaves.filter(p => !p.ok).length,
      skip: selected.filter(p => p.skip).length, todo: selected.filter(p => p.todo).length } };
  writeFileSync(process.env.AXI_RESULT_PATH, JSON.stringify(result, null, 2) + '\n');
  process.exitCode = code === 0 && !signal && !launchError && root?.ok && root.count > 0 &&
    leaves.length > 0 && parserErrors.length === 0 ? 0 : 1;
});
