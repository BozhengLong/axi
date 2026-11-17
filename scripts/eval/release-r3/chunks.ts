import {openSync, closeSync, writeSync, readSync, fsyncSync, fstatSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync, constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export interface ChunkManifest {
  schema: 1; status: 'closed'; bytes: number;
  chunks: {name: string; bytes: number; sha256: string}[];
}

// 这是原始字节分块，不按行切割；长JSON行也可以跨块，不能截掉末尾。
export class ChunkWriter {
  private fd: number | undefined;
  private size = 0;
  private hash = createHash('sha256');
  private finished = false;
  private failed = false;
  private chunks: ChunkManifest['chunks'] = [];
  bytes = 0;

  constructor(readonly directory: string, readonly chunkBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw Error('分块大小无效');
    mkdirSync(directory, {mode: 0o700}); // 已有目录拒绝，避免覆盖另一尝试的证据。
  }

  private name(): string { return String(this.chunks.length).padStart(8, '0') + '.bin'; }
  private sealChunk(): void {
    if (this.fd === undefined) return;
    fsyncSync(this.fd);closeSync(this.fd);this.fd = undefined;
    this.chunks.push({name: this.name(), bytes: this.size, sha256: this.hash.digest('hex')});
    this.size = 0;this.hash = createHash('sha256');
  }

  write(value: string | Uint8Array): void {
    if (this.finished || this.failed) throw Error('证据写入者已结束或失败');
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    try {
      for (let at = 0; at < bytes.byteLength;) {
        this.fd ??= openSync(join(this.directory, this.name()), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const n = writeSync(this.fd, bytes, at, Math.min(bytes.byteLength - at, this.chunkBytes - this.size));
        if (n <= 0) throw Error('证据写入没有进展');
        this.hash.update(bytes.subarray(at, at + n));this.size += n;this.bytes += n;at += n;
        if (this.size === this.chunkBytes) this.sealChunk();
      }
    } catch (error) {
      this.failed = true;
      if (this.fd !== undefined) { try {closeSync(this.fd);} finally {this.fd = undefined;} }
      throw error;
    }
  }

  finish(): ChunkManifest {
    if (this.finished || this.failed) throw Error('不能完成已结束或失败的证据');
    try {
      this.sealChunk();
      const manifest: ChunkManifest = {schema: 1, status: 'closed', bytes: this.bytes, chunks: this.chunks};
      const fd = openSync(join(this.directory, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(manifest) + '\n');fsyncSync(fd); } finally { closeSync(fd); }
      const directoryFd = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      this.finished = true;
      return manifest;
    } catch (error) {
      this.failed = true;
      if (this.fd !== undefined) { try {closeSync(this.fd);} finally {this.fd = undefined;} }
      throw error;
    }
  }
}

export function verifyChunks(directory: string): ChunkManifest {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error('证据目录身份不合法');
  const manifestFile = join(directory, 'manifest.json');
  if (!lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink()) throw Error('证据清单身份不合法');
  const manifest: ChunkManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.schema !== 1 || manifest.status !== 'closed' || !Array.isArray(manifest.chunks)) throw Error('证据没有完整关闭');
  const names = readdirSync(directory).sort(), expected = ['manifest.json', ...manifest.chunks.map(c => c.name)].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw Error('证据存在未登记或缺失文件');
  let total = 0;
  for (const [i, chunk] of manifest.chunks.entries()) {
    if (chunk.name !== String(i).padStart(8, '0') + '.bin' || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0) throw Error('证据块顺序或大小无效');
    const fd = openSync(join(directory, chunk.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);if (!stat.isFile() || stat.size !== chunk.bytes) throw Error('证据块大小不符');
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
      if (hash.digest('hex') !== chunk.sha256) throw Error('证据块哈希不符');
      total += stat.size;
    } finally {closeSync(fd);}
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes !== total) throw Error('证据总字节数不符');
  return manifest;
}
