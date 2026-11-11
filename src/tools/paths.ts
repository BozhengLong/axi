import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { ToolError, stringValue } from "./common.ts";

export const SEARCH_EXCLUDES = ["node_modules", "dist", "build", "coverage", ".next", "target", ".venv", "__pycache__"];
export function reserved(part: string): boolean {
  const p = part.toLowerCase();
  return [".git", ".axi", ".ssh", ".aws", ".gnupg", ".env", ".envrc", "id_rsa", "id_ed25519", "credentials.json"].includes(p) || p.startsWith(".env.") || p.startsWith(".axi-tmp-") || p.endsWith(".pem") || p.endsWith(".key");
}
export function identity(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}`; }
export interface CheckedPath { absolute: string; relative: string; parents: string; stat?: Stats }

export class ProjectPaths {
  readonly root: string;
  private rootIdentity: string;
  constructor(cwd: string) {
    this.root = realpathSync(cwd);
    const stat = lstatSync(this.root);
    if (!stat.isDirectory()) throw new ToolError("invalid_root", "工作目录不是目录。");
    this.rootIdentity = this.directoryIdentity(stat);
  }
  private directoryIdentity(stat: Stats) { return `${stat.dev}:${stat.ino}:${stat.mode}`; }
  check(input: string, kind: "file" | "directory" | "either" = "file", missingLeaf = false): CheckedPath {
    stringValue(input, "path");
    if (input.length > 4096 || /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^file:/i.test(input) || input.split(sep).includes("..")) throw new ToolError("invalid_path", "路径不能含 ..、URL，或超过长度限制。");
    const absolute = resolve(this.root, input), rel = relative(this.root, absolute);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new ToolError("outside_root", "文件工具只能访问当前项目根目录内的路径。");
    const parts = rel ? rel.split(sep) : [];
    if (parts.some(reserved)) throw new ToolError("blocked_path", "文件工具不访问凭据、Git/会话内部文件或 Axi 临时文件。");
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || this.directoryIdentity(rootStat) !== this.rootIdentity) throw new ToolError("path_changed", "项目根目录已变化，请重新启动会话。");
    const parents = [this.rootIdentity];
    let current = this.root, stat: Stats | undefined = rootStat;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      try { stat = lstatSync(current); }
      catch (error) {
        if ((error as { code?: string }).code === "ENOENT" && missingLeaf && i === parts.length - 1) { stat = undefined; break; }
        throw error;
      }
      if (stat.isSymbolicLink()) throw new ToolError("symlink", "文件工具不跟随符号链接。");
      if (i < parts.length - 1) {
        if (!stat.isDirectory()) throw new ToolError("not_directory", "父路径不是目录。");
        parents.push(this.directoryIdentity(stat));
      }
    }
    if (stat) {
      if (!stat.isFile() && !stat.isDirectory()) throw new ToolError("special_file", "文件工具只处理普通文件和目录。");
      if (kind === "file" && !stat.isFile()) throw new ToolError("not_file", "目标不是普通文件。");
      if (kind === "directory" && !stat.isDirectory()) throw new ToolError("not_directory", "目标不是目录。");
      if (stat.isFile() && stat.nlink !== 1) throw new ToolError("hardlink", "文件工具不处理多硬链接文件。");
    }
    return { absolute, relative: rel || ".", parents: parents.join("/"), stat };
  }
}
