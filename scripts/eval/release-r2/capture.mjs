// 由独立、无网络、只读挂载的Linux辅助进程运行；调用前须暂停全部任务写入者。
import { readdir, lstat, readFile, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2] || '/task');
const rootStat = await lstat(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('snapshot root must be a real directory');
const excluded = new Set(['node_modules', '.git', '.axi', '.claude']);
const files = {}, metadata = {};
let totalBytes = 0, entries = 0;
async function walk(directory = '') {
  for (const child of (await readdir(join(root, directory))).sort()) {
    if (excluded.has(child)) continue;
    const name = directory ? directory + '/' + child : child;
    if (++entries > 15000) throw Error('snapshot entries exceed 15000');
    const path = join(root, name), stat = await lstat(path);
    const mode = stat.mode & 0o7777;
    metadata[name] = { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, uid: stat.uid, gid: stat.gid, size: stat.size, mode };
    if (stat.isSymbolicLink()) files[name] = { type: 'symlink', mode, target: await readlink(path) };
    else if (stat.isDirectory()) { files[name] = { type: 'directory', mode }; await walk(name); }
    else if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > 128 * 1024 * 1024) throw Error('snapshot bytes exceed 128 MiB');
      files[name] = { type: 'file', mode, data: (await readFile(path)).toString('base64') };
    } else files[name] = { type: 'special', mode };
  }
}
await walk();
const gitPath = await lstat(join(root, '.git'));
if (!gitPath.isDirectory() || gitPath.isSymbolicLink()) throw Error('Git metadata must remain an ordinary directory');
const git = (args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { PATH: process.env.PATH, HOME: '/tmp', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
});
console.log(JSON.stringify({ schema: 1, files, metadata, totalBytes, entries,
  git: { head: git(['rev-parse', 'HEAD']).trim(), index: git(['ls-files', '--stage']), status: git(['status', '--porcelain=v1', '--untracked-files=all']) },
  excludes: [...excluded], requiresPausedWriters: true }));
