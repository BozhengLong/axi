import { openSync, closeSync, readSync, writeSync, fstatSync, fchmodSync, fsyncSync, lstatSync, unlinkSync, linkSync, renameSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { noLog, type RecordLog } from "../api/types.ts";
import { visibleText } from "../text.ts";
import { ProjectPaths, identity, type CheckedPath } from "./paths.ts";
import { FILE_BYTES, TEXT_LIMIT, ToolError, errorCode, freeze, lines, points, result, type ToolExecution } from "./common.ts";

export interface FileSnapshot { path: CheckedPath; text: string; hash: string; bytes: Buffer; identity: string }
export interface FileHooks { checkpoint?: (phase: string) => Promise<void> | void }
export interface MutationProposal {
  id: string; operation: "write" | "edit"; path: string; preview: string; previewHash: string;
  beforeHash: string | null; afterHash: string; baseVersion?: string;
}
interface MutationState { path: CheckedPath; before?: FileSnapshot; bytes: Buffer; text: string; mode: number; consumed: boolean }
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// 单处替换只需要完整变化区间，无须引入无上限的最短差异算法。
function preview(path: string, before: string | undefined, after: string): string {
  const a = lines(before ?? ""), b = lines(after); let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const render = (mark: string, line: string) => mark + line + (line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
  const sections = [a.slice(start, prefix).map(l => render(" ", l)), a.slice(prefix, a.length - suffix).map(l => render("-", l)), b.slice(prefix, b.length - suffix).map(l => render("+", l)), a.slice(a.length - suffix, a.length - suffix + tail).map(l => render(" ", l))];
  const diff = `--- ${before === undefined ? "/dev/null（新文件）" : JSON.stringify(path) + "（当前）"}\n+++ ${JSON.stringify(path)}（拟写入）\n@@ -${start + 1},${a.length - suffix - start + tail} +${start + 1},${b.length - suffix - start + tail} @@\n` + sections.flat().join("");
  if (points(visibleText(diff)) > TEXT_LIMIT) throw new ToolError("diff_too_large", "完整差异超过展示上限。请拆小修改，不能在截断的差异上批准。");
  return diff;
}

export class FileWorkspace {
  readonly paths: ProjectPaths;
  private versions = new Map<string, { version: string; fingerprint: string }>();
  private checkpoints = 0;
  private proposals = new WeakMap<MutationProposal, MutationState>();
  private committing = false;
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

  private proposal(operation: "write" | "edit", path: CheckedPath, text: string, before?: FileSnapshot, baseVersion?: string): MutationProposal {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > FILE_BYTES) throw new ToolError("file_too_large", "拟写入内容超过1MiB。");
    const diff = preview(path.relative, before?.text, text);
    const proposal = freeze({ id: crypto.randomUUID(), operation, path: path.relative, preview: diff, previewHash: hash(diff), beforeHash: before?.hash ?? null, afterHash: hash(bytes), ...(baseVersion ? { baseVersion } : {}) });
    this.proposals.set(proposal, { path, before, bytes, text, mode: before ? before.path.stat!.mode & 0o777 : 0o644 & ~process.umask(), consumed: false });
    return proposal;
  }
  async prepareEdit(path: string, version: string, oldText: string, newText: string, signal: AbortSignal): Promise<MutationProposal> {
    const before = await this.snapshot(path, signal); this.requireVersion(before, version);
    if (!oldText.length) throw new ToolError("invalid_input", "old_text 不能为空。");
    const at = before.text.indexOf(oldText);
    if (at < 0) throw new ToolError("no_match", "未找到完整 old_text，请重新读取并提供准确上下文。");
    if (before.text.indexOf(oldText, at + 1) >= 0) throw new ToolError("ambiguous_match", "old_text 出现多次（含重叠），不能猜测替换位置。");
    return this.proposal("edit", before.path, before.text.slice(0, at) + newText + before.text.slice(at + oldText.length), before, version);
  }
  prepareWrite(path: string, text: string, signal: AbortSignal): MutationProposal {
    signal.throwIfAborted(); const target = this.paths.check(path, "file", true);
    if (target.stat) throw new ToolError("already_exists", "write 只创建新文件，不能覆盖已有目标。已有文件请先 read 再 edit。");
    return this.proposal("write", target, text);
  }
  async commit(proposal: MutationProposal, signal: AbortSignal, record: RecordLog = noLog): Promise<ToolExecution> {
    const state = this.proposals.get(proposal);
    if (!state || state.consumed) throw new ToolError("invalid_proposal", "提案不存在或已使用，不能重复执行。");
    if (this.committing) throw new ToolError("write_busy", "当前会话已有文件提交，不能并发执行。");
    state.consumed = true; this.committing = true;
    let temp = "", fd: number | undefined, owned: string | undefined, published = false, attempted = false;
    const warnings: string[] = [];
    const cleanup = () => {
      if (fd !== undefined) { try { closeSync(fd); } catch { warnings.push("临时文件描述符关闭失败"); } fd = undefined; }
      if (temp && owned) {
        try {
          const s = lstatSync(temp);
          if (`${s.dev}:${s.ino}` === owned && !s.isSymbolicLink()) unlinkSync(temp);
          else warnings.push("临时路径身份已改变，未删除其他文件");
        } catch (e) { if ((e as { code?: string }).code !== "ENOENT") warnings.push("临时文件清理失败，请检查 " + JSON.stringify(temp)); }
      }
    };
    const revalidate = async () => {
      const current = this.paths.check(state.path.absolute, "file", true);
      if (current.parents !== state.path.parents) throw new ToolError("path_changed", "父目录在确认期间变化，旧授权失效。");
      if (state.before) {
        if (!current.stat) throw new ToolError("stale_version", "目标已被移除，旧授权失效。");
        const now = await this.snapshot(state.path.absolute, signal);
        if (this.fingerprint(now) !== this.fingerprint(state.before)) throw new ToolError("stale_version", "文件在确认期间变化。请重新 read、提出修改并确认。");
      } else if (current.stat) throw new ToolError("already_exists", "确认期间目标已被创建，没有覆盖。");
    };
    try {
      signal.throwIfAborted(); await revalidate();
      record("commit_prepared", { proposalId: proposal.id, operation: proposal.operation, path: proposal.path, beforeHash: proposal.beforeHash, afterHash: proposal.afterHash, previewHash: proposal.previewHash });
      if (state.before?.hash === proposal.afterHash) return result(proposal.operation, proposal.path, { status: "unchanged", version: this.remember(state.before), message: "内容未变化，未写入文件。" });
      await this.checkpoint("before_temp", signal);
      await revalidate();
      temp = join(dirname(state.path.absolute), `.axi-tmp-${crypto.randomUUID()}`);
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const tempStat = fstatSync(fd); owned = `${tempStat.dev}:${tempStat.ino}`;
      for (let offset = 0; offset < state.bytes.length;) {
        await this.checkpoint("write_chunk", signal);
        const n = writeSync(fd, state.bytes, offset, Math.min(65536, state.bytes.length - offset));
        if (n <= 0) throw new ToolError("short_write", "临时文件没有完成写入。");
        offset += n;
      }
      fsyncSync(fd); fchmodSync(fd, state.mode);
      const verified = Buffer.alloc(state.bytes.length); let offset = 0;
      while (offset < verified.length) { const n = readSync(fd, verified, offset, verified.length - offset, offset); if (!n) break; offset += n; }
      if (offset !== verified.length || fstatSync(fd).size !== state.bytes.length || hash(verified) !== proposal.afterHash) throw new ToolError("write_verification", "临时文件与已确认内容不符，未提交。");
      await this.checkpoint("before_commit", signal);
      record("commit_start", { proposalId: proposal.id, path: proposal.path });
      await revalidate(); signal.throwIfAborted();
      const lastTemp = lstatSync(temp), finalBytes = Buffer.alloc(state.bytes.length);
      if (lastTemp.isSymbolicLink() || `${lastTemp.dev}:${lastTemp.ino}` !== owned || lastTemp.nlink !== 1 || lastTemp.size !== state.bytes.length) throw new ToolError("temp_changed", "临时路径已变化，未提交。");
      let verifiedCount = 0;
      while (verifiedCount < finalBytes.length) { const n = readSync(fd, finalBytes, verifiedCount, finalBytes.length - verifiedCount, verifiedCount); if (!n) break; verifiedCount += n; }
      if (verifiedCount !== finalBytes.length || hash(finalBytes) !== proposal.afterHash) throw new ToolError("temp_changed", "临时内容已变化，未提交。");
      // 最后检查与发布之间不再 await。此处不声称能隔离外部程序的竞争写入。
      attempted = true;
      if (state.before) renameSync(temp, state.path.absolute);
      else linkSync(temp, state.path.absolute); // EEXIST 不覆盖竞争创建的目标。
      published = true;
      cleanup();
      try {
        // 已进入提交后，即使收到取消，也要确认本次实际副作用。
        await this.hooks.checkpoint?.("after_commit");
        const now = await this.snapshot(state.path.absolute, new AbortController().signal);
        if (now.hash !== proposal.afterHash || (now.path.stat!.mode & 0o777) !== state.mode) throw new ToolError("post_commit_changed", "提交后目标已变化。");
        const version = this.remember(now);
        const applied = result(proposal.operation, proposal.path, { status: "applied", modified: true, version, before_hash: proposal.beforeHash, after_hash: now.hash, proposal_id: proposal.id, cancel_requested: signal.aborted, warnings });
        try { record("commit_result", { proposalId: proposal.id, path: proposal.path, status: "applied", modified: true, version, afterHash: now.hash, cancelRequested: signal.aborted, warnings }); }
        catch { return { ...applied, fatal: true, content: JSON.stringify({ ...JSON.parse(applied.content), code: "post_commit_log_error", message: "修改已应用，但日志写入失败；停止后续操作。" }) }; }
        return warnings.length ? { ...applied, fatal: true } : applied;
      } catch (error) {
        try { record("commit_result", { proposalId: proposal.id, path: proposal.path, status: "unknown", modified: true, commitSucceeded: true, error: String(error) }); } catch {}
        return result(proposal.operation, proposal.path, { status: "unknown", code: "post_commit_unknown", modified: true, commit_succeeded: true, message: String(error), warnings }, true);
      }
    } catch (error) {
      cleanup();
      if (attempted && !published && errorCode(error) !== "EEXIST") return result(proposal.operation, proposal.path, { status: "unknown", code: "commit_unknown", modified: "unknown", message: String(error), warnings }, true);
      if (warnings.length) return { ...result(proposal.operation, proposal.path, { status: signal.aborted ? "cancelled" : "failed", code: errorCode(error), message: String(error), warnings }, true), fatal: true };
      throw error;
    } finally { cleanup(); this.committing = false; }
  }
}
