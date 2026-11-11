import { type JsonObject, type RecordLog, type ToolUse } from "../api/types.ts";
import { bashTool, parseBashInput, runBash, type BashInput, type BashResult } from "./bash.ts";
import { FileWorkspace } from "./files.ts";
import { fields, freeze, integer, stringValue, ToolError, type ToolExecution } from "./common.ts";
import { search } from "./search.ts";

const str = { type: "string" };
const schema = (name: string, description: string, properties: JsonObject, required: string[]) => ({ name, description, input_schema: { type: "object", properties, required, additionalProperties: false } });
export const toolDefinitions = [
  bashTool,
  schema("read", "读取项目内普通 UTF-8 文件，返回原文、起止行号与完整文件 version。默认200行，最多2000行/30000码点，文件最多1MiB。只能用返回的版本提出 edit；不支持链接、凭据或 .git/.axi。", { path: str, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["path"]),
  schema("glob", "在项目内按路径 glob 匹配文件，最多200条；返回范围、排除和截断。不是完整 .gitignore 实现。", { path: str, pattern: str }, ["pattern"]),
  schema("grep", "在项目内逐行搜索区分大小写的字面量（不是正则），可用 glob 缩小路径，最多200条。排除构建/依赖/凭据目录；不授予编辑版本。", { path: str, pattern: str, glob: str }, ["pattern"]),
];
export interface PermissionView { effect: "read" | "write" | "shell"; path?: string; preview?: string; proposalId?: string; previewHash?: string }
export interface PreparedTool extends PermissionView { tool: ToolUse; execute(signal: AbortSignal, record?: RecordLog): Promise<ToolExecution> }

export class ToolRegistry {
  private files?: FileWorkspace;
  constructor(private cwd: string, private bash: typeof runBash = runBash) {}
  get workspace(): FileWorkspace { return this.files ??= new FileWorkspace(this.cwd); }
  async prepare(original: ToolUse, signal: AbortSignal): Promise<PreparedTool> {
    signal.throwIfAborted();
    const tool = freeze(structuredClone(original)), input = tool.input;
    if (tool.name === "bash") {
      const parsed: BashInput = parseBashInput(input);
      return { tool, effect: "shell", execute: async signal => {
        const r: BashResult = await this.bash(parsed, this.cwd, signal);
        return { content: r.content, isError: r.isError, status: r.outcome, modified: "unknown" };
      } };
    }
    if (tool.name === "read") {
      fields(input, ["path", "offset", "limit"], ["path"]);
      const path = stringValue(input.path, "path"), offset = integer(input.offset, 1, Number.MAX_SAFE_INTEGER), limit = integer(input.limit, 200, 2000);
      const checked = this.workspace.paths.check(path);
      return { tool, effect: "read", path: checked.relative, execute: signal => this.workspace.read(path, offset, limit, signal) };
    }
    if (tool.name === "glob" || tool.name === "grep") {
      fields(input, tool.name === "glob" ? ["path", "pattern"] : ["path", "pattern", "glob"], ["pattern"]);
      const path = input.path === undefined ? "." : stringValue(input.path, "path"), pattern = stringValue(input.pattern, "pattern"), filter = input.glob === undefined ? undefined : stringValue(input.glob, "glob");
      if (pattern.length > 1024 || (filter?.length ?? 0) > 1024) throw new ToolError("invalid_input", "搜索模式不能超过1024字符。");
      const checked = this.workspace.paths.check(path, "either"), name = tool.name;
      return { tool, effect: "read", path: checked.relative, execute: signal => search(this.workspace, name, path, pattern, filter, signal) };
    }
    throw new ToolError("unknown_tool", `不支持工具 ${tool.name}，工具未执行。`);
  }
}
