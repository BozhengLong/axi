import { openSync, closeSync, readSync, fstatSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { ProjectPaths, identity, type CheckedPath } from "./paths.ts";
import { FILE_BYTES, TEXT_LIMIT, ToolError, lines, points, result, type ToolExecution } from "./common.ts";

export interface FileSnapshot { path: CheckedPath; text: string; hash: string; bytes: Buffer; identity: string }
export interface FileHooks { checkpoint?: (phase: string) => Promise<void> | void }

export class FileWorkspace {
  readonly paths: ProjectPaths;
  private versions = new Map<string, { version: string; fingerprint: string }>();
  private checkpoints = 0;
  constructor(cwd: string, readonly hooks: FileHooks = {}) { this.paths = new ProjectPaths(cwd); }
  async checkpoint(phase: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await this.hooks.checkpoint?.(phase);
    // 目录项批量让出；文件分块每次让出，避免长扫描阻塞 Ctrl+C。
    if (phase !== "search_entry" || ++this.checkpoints % 32 === 0) await Bun.sleep(0);
    signal.throwIfAborted();
  }
  fingerprint(file: FileSnapshot): string { return `${file.path.parents}|${file.identity}|${file.hash}`; }
  remember(file: FileSnapshot): string {
    const path = file.path.absolute, fingerprint = this.fingerprint(file);
    const prior = this.versions.get(path);
    const version = prior?.fingerprint === fingerprint ? prior.version : crypto.randomUUID();
    this.versions.delete(path); this.versions.set(path, { version, fingerprint });
    if (this.versions.size > 1000) this.versions.delete(this.versions.keys().next().value!);
    return version;
  }
  requireVersion(file: FileSnapshot, version: string): void {
    const prior = this.versions.get(file.path.absolute);
    if (!prior || prior.version !== version || prior.fingerprint !== this.fingerprint(file)) throw new ToolError("stale_version", "文件版本无效或已经变化。请重新 read，并提出新的修改。");
  }
  async snapshot(input: string, signal: AbortSignal, maxBytes = FILE_BYTES): Promise<FileSnapshot> {
    signal.throwIfAborted();
    const path = this.paths.check(input);
    if (path.stat!.size > maxBytes) throw new ToolError("file_too_large", `文件超过 ${maxBytes} 字节限制。`);
    const fd = openSync(path.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || identity(before) !== identity(path.stat!)) throw new ToolError("path_changed", "打开的文件与校验目标不同。");
      const chunks: Buffer[] = []; let size = 0;
      while (true) {
        await this.checkpoint("read_chunk", signal);
        const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
        const n = readSync(fd, buffer, 0, buffer.length, null);
        if (!n) break;
        size += n;
        if (size > maxBytes) throw new ToolError("file_too_large", "文件在读取中超过限制。");
        chunks.push(buffer.subarray(0, n));
      }
      const after = fstatSync(fd), finalPath = this.paths.check(input);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || identity(before) !== identity(after) || identity(after) !== identity(finalPath.stat!) || path.parents !== finalPath.parents) throw new ToolError("file_changed", "文件在读取期间发生变化，请重试读取。");
      const bytes = Buffer.concat(chunks);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new ToolError("unsupported_encoding", "文件不是有效 UTF-8 文本。"); }
      if (text.includes("\0")) throw new ToolError("binary_file", "文件含 NUL，不按文本读取。");
      signal.throwIfAborted();
      return { path: finalPath, text, bytes, hash: createHash("sha256").update(bytes).digest("hex"), identity: identity(after) };
    } finally { closeSync(fd); }
  }
  async read(path: string, offset: number, limit: number, signal: AbortSignal): Promise<ToolExecution> {
    const file = await this.snapshot(path, signal), all = lines(file.text);
    let content = "", size = 0, end = Math.min(offset - 1, all.length);
    for (let i = offset - 1; i < Math.min(all.length, offset - 1 + limit); i++) {
      const line = all[i]!, length = points(line);
      if (length > TEXT_LIMIT) throw new ToolError("line_too_long", `第 ${i + 1} 行超过文本输出限制。`);
      if (size + length > TEXT_LIMIT) break;
      content += line; size += length; end = i + 1;
    }
    signal.throwIfAborted();
    return result("read", file.path.relative, { content, version: this.remember(file), start_line: offset, end_line: end, total_lines: all.length, next_offset: end < all.length ? end + 1 : null, truncated: end < all.length, bytes: file.bytes.length });
  }
}
