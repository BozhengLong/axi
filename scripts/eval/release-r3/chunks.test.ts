import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChunkWriter, verifyChunks} from './chunks.ts';

test('分块跨越UTF-8和JSON行，字节顺序保持；篡改、缺块和错误总量被拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'axi-r3-chunks-'));
  try {
    const dir = join(root, 'trace'), writer = new ChunkWriter(dir, 7), input = Buffer.from('{"正文":"中文🙂"}\n'.repeat(20));
    writer.write(input.subarray(0, 9));writer.write(input.subarray(9));
    expect(() => verifyChunks(dir)).toThrow();
    const m = writer.finish();expect(verifyChunks(dir)).toEqual(m);
    expect(Buffer.concat(m.chunks.map(c => readFileSync(join(dir, c.name))))).toEqual(input);
    expect(() => writer.write('late')).toThrow();expect(() => new ChunkWriter(dir)).toThrow();
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({...m, bytes: m.bytes + 1}));expect(() => verifyChunks(dir)).toThrow('总字节');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    const second = join(dir, m.chunks[1]!.name), original = readFileSync(second);rmSync(second);expect(() => verifyChunks(dir)).toThrow('缺失');writeFileSync(second, original);
    writeFileSync(join(dir, 'unlisted.bin'), 'extra');expect(() => verifyChunks(dir)).toThrow('未登记');rmSync(join(dir, 'unlisted.bin'));
    const first = join(dir, m.chunks[0]!.name);writeFileSync(first, 'changed');expect(() => verifyChunks(dir)).toThrow('哈希');
    writeFileSync(first, input.subarray(0, 7));rmSync(first);symlinkSync('/etc/hosts', first);expect(() => verifyChunks(dir)).toThrow();
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('封存失败后不能继续追加或重新宣称完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'axi-r3-seal-fail-'));
  try {
    const writer = new ChunkWriter(join(root, 'trace'));writer.write('original');
    const manifest = join(writer.directory, 'manifest.json');writeFileSync(manifest, 'occupied');
    expect(() => writer.finish()).toThrow();rmSync(manifest);
    expect(() => writer.finish()).toThrow('失败');expect(() => writer.write('late')).toThrow('失败');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('超过旧200 MiB后仍保留所有字节，使用固定大小缓冲核对', () => {
  const root = mkdtempSync(join(tmpdir(), 'axi-r3-large-'));
  try {
    const writer = new ChunkWriter(join(root, 'trace')), block = Buffer.alloc(1024 * 1024, 97);
    for (let i = 0; i < 201; i++) writer.write(block);
    const manifest = writer.finish();expect(manifest.bytes).toBe(201 * 1024 * 1024);expect(manifest.chunks).toHaveLength(4);
    expect(verifyChunks(writer.directory)).toEqual(manifest);
  } finally {rmSync(root, {recursive: true, force: true});}
});
