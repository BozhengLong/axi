import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// 只执行冻结候选的本地工程检查。不得从设施工作区隐式加载产品。
const [candidateArg, outputArg, platform] = process.argv.slice(2);
if (!candidateArg || !outputArg || !['macos', 'linux'].includes(platform!)) throw new Error('用法：bun baseline.ts C目录 输出目录 macos|linux');
const candidate = resolve(candidateArg), output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const planPath = join(output, 'plan.json');
if (await Bun.file(planPath).exists()) throw new Error('已有运行计划，拒绝覆盖或重抽样');
const commands = [ ['bun', 'install', '--frozen-lockfile'], ['bun', 'run', 'typecheck'], ...Array.from({length: 5}, () => ['bun', 'test']) ];
const identity = JSON.parse(readFileSync(join(output, '..', 'candidate.json'), 'utf8'));
const checkSource = () => {
  for (const file of identity.files) {
    const actual = createHash('sha256').update(readFileSync(join(candidate, file.path))).digest('hex');
    if (actual !== file.sha256) throw new Error(`候选文件变化：${file.path}`);
  }
};
checkSource();
writeFileSync(planPath, JSON.stringify({ candidate: identity.candidate, platform, commands, repeats: 5, createdAt: new Date().toISOString() }, null, 2));
const results: unknown[] = [];
for (const [index, command] of commands.entries()) {
  const start = Date.now();
  // 不加载宿主模型凭据；所有模型回复来自测试自身的本地模拟HTTP。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/ANTHROPIC|OPENAI|AXI_|CLAUDE|CODEX/.test(key)));
  const child = Bun.spawn(command, { cwd: candidate, env, stdout: Bun.file(join(output, `${index}.stdout`)), stderr: Bun.file(join(output, `${index}.stderr`)) });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
  const code = await child.exited; clearTimeout(timer);
  const row = { index, command, exitCode: code, elapsedMs: Date.now() - start };
  results.push(row); writeFileSync(join(output, 'results.json'), JSON.stringify({ candidate: identity.candidate, platform, results }, null, 2));
  console.log(JSON.stringify(row));
  // 安装或类型错误时后续检查没有有效前提。测试失败仍保留预定五次复现，不选最好一次。
  if (index < 2 && code !== 0) break;
}
checkSource();
console.log(JSON.stringify({ completed: true, sourceUnchanged: true }));
