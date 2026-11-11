import { isObject, type JsonObject } from "../api/types.ts";

export const FILE_BYTES = 1024 * 1024;
export const TEXT_LIMIT = 30000;
export class ToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface ToolExecution {
  content: string;
  isError: boolean;
  status: string;
  modified: boolean | "unknown";
  path?: string;
  fatal?: boolean;
}
export function result(operation: string, path: string, data: JsonObject, isError = false): ToolExecution {
  const body = { status: "completed", code: "ok", operation, path, modified: false, truncated: false, ...data };
  return { content: JSON.stringify(body), isError, status: String(body.status), modified: body.modified as boolean | "unknown", path, ...(body.status === "unknown" ? { fatal: true } : {}) };
}
export function errorCode(error: unknown): string {
  if (error instanceof ToolError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "io_error";
}
export function fields(input: JsonObject, allowed: string[], required: string[]): void {
  if (!isObject(input) || Object.keys(input).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(input, k))) throw new ToolError("invalid_input", "工具参数缺失或包含未知字段。");
}
export function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.length) || value.includes("\0")) throw new ToolError("invalid_input", `${name} 必须是${allowEmpty ? "" : "非空"}字符串，且不能包含 NUL。`);
  // 编码再解码必须不损坏模型提供的字符串；拒绝孤立代理项。
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) !== value) throw new ToolError("invalid_input", `${name} 包含无效 Unicode。`);
  return value;
}
export function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new ToolError("invalid_input", `数字必须是 1 至 ${max} 的整数。`);
  return value;
}
export function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
export function points(text: string): number { return Array.from(text).length; }
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
