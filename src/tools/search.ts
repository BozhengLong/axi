import { opendir } from "node:fs/promises";
import { relative, join } from "node:path";
import { FileWorkspace } from "./files.ts";
import { SEARCH_EXCLUDES, reserved } from "./paths.ts";
import { FILE_BYTES, TEXT_LIMIT, ToolError, errorCode, lines, points, result, type ToolExecution } from "./common.ts";

export async function search(workspace: FileWorkspace, operation: "glob" | "grep", path: string, pattern: string, filter: string | undefined, signal: AbortSignal): Promise<ToolExecution> {
  const start = performance.now(), target = workspace.paths.check(path, "either"), scope = target.absolute;
  let matcher: Bun.Glob;
  try { matcher = new Bun.Glob(operation === "glob" ? pattern : filter ?? "**/*"); }
  catch { throw new ToolError("invalid_pattern", "无效路径匹配模式。"); }
  const found: unknown[] = [], skipped: Record<string, number> = {};
  let visited = 0, bytes = 0, outputSize = 0, stop = "";
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const checkpoint = async () => {
    await workspace.checkpoint("search_entry", signal);
    if (performance.now() - start >= 5000) stop ||= "time_limit";
    return !stop;
  };
  const inspect = async (absolute: string) => {
    if (!await checkpoint()) return;
    let checked;
    try { checked = workspace.paths.check(absolute, "either"); }
    catch (error) { skip(errorCode(error)); return; }
    if (checked.stat!.isDirectory()) { await walk(absolute); return; }
    const local = relative(scope, absolute) || checked.relative.split("/").at(-1)!;
    if (!matcher.match(local)) return;
    if (operation === "glob") {
      if (found.length >= 200) { stop = "result_limit"; return; }
      found.push(checked.relative); return;
    }
    if (checked.stat!.size > FILE_BYTES) { skip("file_too_large"); return; }
    if (bytes + checked.stat!.size > 32 * FILE_BYTES) { stop = "byte_limit"; return; }
    let file;
    try { file = await workspace.snapshot(absolute, signal, Math.min(FILE_BYTES, 32 * FILE_BYTES - bytes)); }
    catch (error) { if (signal.aborted) throw error; skip(errorCode(error)); return; }
    bytes += file.bytes.length;
    for (const [i, line] of lines(file.text).entries()) {
      if (!line.includes(pattern)) continue;
      const length = points(line);
      if (found.length >= 200 || outputSize + length > TEXT_LIMIT) { stop = found.length >= 200 ? "result_limit" : "output_limit"; return; }
      found.push({ path: file.path.relative, line: i + 1, content: line }); outputSize += length;
    }
  };
  const walk = async (directory: string): Promise<void> => {
    const entries: string[] = [];
    try {
      const dir = await opendir(directory);
      for await (const entry of dir) {
        if (!await checkpoint()) break;
        if (++visited > 20000) { stop = "entry_limit"; break; }
        if (reserved(entry.name)) { skip("blocked_path"); continue; }
        if (SEARCH_EXCLUDES.includes(entry.name.toLowerCase()) && entry.isDirectory()) { skip("excluded_directory"); continue; }
        entries.push(entry.name);
      }
    } catch (error) { if (signal.aborted) throw error; skip(errorCode(error)); }
    for (const entry of entries.sort()) { if (stop) break; await inspect(join(directory, entry)); }
  };
  try {
    if (target.relative.split("/").some(p => SEARCH_EXCLUDES.includes(p.toLowerCase()))) skip("excluded_directory");
    else await inspect(scope);
  } catch (error) { if (signal.aborted) stop = "cancelled"; else throw error; }
  const incomplete = !!stop || Object.keys(skipped).length > 0;
  found.sort((a, b) => {
    const x = typeof a === "string" ? a : (a as { path: string }).path;
    const y = typeof b === "string" ? b : (b as { path: string }).path;
    return x < y ? -1 : x > y ? 1 : (a as { line: number }).line - (b as { line: number }).line;
  });
  return result(operation, target.relative, { status: stop === "cancelled" ? "cancelled" : "completed", code: stop || "ok", results: found, incomplete, truncated: !!stop, skipped, visited, bytes_read: bytes, scope: target.relative, excludes: SEARCH_EXCLUDES, gitignore: "not_interpreted" }, stop === "cancelled");
}
