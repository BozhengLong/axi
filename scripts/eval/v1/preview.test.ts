import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWorkspace } from "../../../src/tools/files.ts";
import { applyPreview, verifyPermission } from "./preview.ts";
import { createHash } from "node:crypto";
import { normalizeTerminal } from "./adapter.ts";

test("E-03：清除 readline 重绘提示，但保留工具正文的普通大于号", () => {
  expect(normalizeTerminal("正文 > text\r\n\x1b[1G\x1b[0J> \x1b[3G应用这次修改？[y/N] ")).toBe("正文 > text\n应用这次修改？[y/N] ");
});

test("E-04：独立应用预览补丁还原完整修改，不能靠伪造摘要通过", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "v1-preview-")));
  try {
    const w = new FileWorkspace(root), signal = new AbortController().signal;
    for (const [before, after] of [["", "新🙂"], ["", ""], ["same", "same"], ["a\r\nb", "a\r\nc\n"], ["same\nold\nlast", "same\nnew\nlast"], ["\ufeffx\n", "\ufeffy\n"], ["gone", ""]] as const) {
      writeFileSync(join(root, "a"), before);
      const p = before ? await w.prepareEdit("a", JSON.parse((await w.read("a", 1, 200, signal)).content).version, before, after, signal) : w.prepareWrite("new", after, signal);
      expect(applyPreview(before, p.preview)).toBe(after);
    }
    const p = w.prepareWrite("new", "abc", signal);
    const tool = { type: "tool_use" as const, id: "id", name: "write", input: { path: "new", content: "abc" } };
    const request = { toolUseId: "id", name: "write", input: tool.input, effect: "write", path: "new", proposalId: p.id, preview: p.preview, previewHash: p.previewHash };
    const proposal = { ...request, beforeHash: p.beforeHash, afterHash: p.afterHash };
    expect(verifyPermission(tool, { request, proposal, file: null }).expected).toContain("+abc");
    const falsePreview = p.preview.replace("+abc", "+abd"), fakeHash = createHash("sha256").update(falsePreview).digest("hex");
    expect(() => verifyPermission(tool, { request: { ...request, preview: falsePreview, previewHash: fakeHash }, proposal: { ...proposal, preview: falsePreview, previewHash: fakeHash }, file: null })).toThrow("差异未覆盖");
    expect(() => verifyPermission({ ...tool, input: { path: "../outside", content: "abc" } }, { request, proposal, file: null })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
