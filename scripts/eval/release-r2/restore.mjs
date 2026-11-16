// 仅在新建、无依赖挂载的Linux任务卷中重建封存文件，Git单独由固定初态提供。
import { readFile, readdir, rm, mkdir, writeFile, symlink, chmod, lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
const files = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = '/task';
const protectedRoots = new Set(['.git', 'node_modules', '.axi', '.claude']);
const entries = Object.entries(files);
if (entries.length > 15000) throw Error('too many snapshot entries');
let bytes = 0;
for (const [name, entry] of entries) {
  if (!name || posix.isAbsolute(name) || posix.normalize(name) !== name || name.includes('\0') || name.split('/').includes('..') || name.split('/').some(x => protectedRoots.has(x))) throw Error('unsafe snapshot path');
  if (!['directory', 'file', 'symlink'].includes(entry.type) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) throw Error('invalid snapshot entry');
  let parent = posix.dirname(name);
  while (parent !== '.') {
    if (files[parent] && files[parent].type !== 'directory') throw Error('non-directory snapshot parent');
    parent = posix.dirname(parent);
  }
  if (entry.type === 'file') {
    const data = Buffer.from(entry.data, 'base64');
    if (data.toString('base64') !== entry.data) throw Error('invalid base64');
    bytes += data.length;
  }
  if (entry.type === 'symlink' && typeof entry.target !== 'string') throw Error('invalid symlink');
}
if (bytes > 128 * 1024 * 1024) throw Error('snapshot too large');
if (!(await lstat(root)).isDirectory() || !(await lstat(join(root, '.git'))).isDirectory()) throw Error('missing seed Git directory');
for (const name of await readdir(root)) {
  if (name !== '.git') await rm(join(root, name), {recursive: true, force: true});
}
for (const [name, entry] of entries.filter(([,e]) => e.type === 'directory').sort(([a],[b]) => a.length-b.length)) await mkdir(join(root,name), {recursive:true});
for (const [name, entry] of entries.filter(([,e]) => e.type === 'file')) {
  await mkdir(posix.dirname(join(root,name)), {recursive:true});
  await writeFile(join(root,name), Buffer.from(entry.data,'base64'));
  await chmod(join(root,name),entry.mode);
}
for (const [name, entry] of entries.filter(([,e]) => e.type === 'symlink')) {
  await mkdir(posix.dirname(join(root,name)),{recursive:true});
  await symlink(entry.target,join(root,name));
}
for (const [name, entry] of entries.filter(([,e]) => e.type === 'directory').sort(([a],[b]) => b.length-a.length)) await chmod(join(root,name),entry.mode);
console.log(JSON.stringify({restored:entries.length,bytes}));
