export type Effort = "medium" | "high";
export type JsonObject = Record<string, unknown>;
export type ContentBlock = JsonObject & { type: string };
export type ToolUse = ContentBlock & {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
};
export type ToolResult = ContentBlock & {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
};
export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}
export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string;
  usage: Record<string, number>;
}
export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
}
export type RecordLog = (kind: string, data: unknown) => void;
export const noLog: RecordLog = () => {};

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function abortError(): Error {
  return new DOMException("用户已中止", "AbortError");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
