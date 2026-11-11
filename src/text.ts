// 仅转换展示副本；原始模型消息、文件内容和命令保持不变。
export function visibleText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
