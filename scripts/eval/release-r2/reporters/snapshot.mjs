// 被测容器暂停后，由独立只读容器检查同一个任务卷，避免跟随运行中的路径替换。
import { readFileSync, lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = realpathSync('/task');
const paths = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const files = {};
for (const name of paths) {
  assert(!isAbsolute(name) && !name.split('/').includes('..'));
  const path = resolve(root, name);
  for (let p = dirname(path); p !== root; p = dirname(p)) {
    assert(!relative(root, p).startsWith('..') && !lstatSync(p).isSymbolicLink());
  }
  const st = lstatSync(path);
  files[name] = st.isSymbolicLink()
    ? { type: 'symlink', target: readlinkSync(path), mode: st.mode & 511 }
    : (assert(st.isFile()), { type: 'file', sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), mode: st.mode & 511 });
}
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = Object.fromEntries([['head', ['rev-parse', 'HEAD']], ['index', ['ls-files', '--stage']]]
  .map(([label, args]) => [label, execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' })]));
process.stdout.write(JSON.stringify({ files, git }));
