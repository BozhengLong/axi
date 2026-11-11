import { expect, test } from "bun:test";
import { parseTestRun, regressionValid } from "./regression.ts";
import { classifyExecution } from "./outcome.ts";

test("回归判定要求旧代码行为断言失败，拒绝空断言、缺报告和导入错误", () => {
  const result = (code: number) => ({ exitCode: code, stdout: "", stderr: "" });
  const report = (failed: number, messages: string[]) => JSON.stringify({ numTotalTests: 1, numPassedTests: 1 - failed, numFailedTests: failed, numPendingTests: 0, testResults: [{ assertionResults: [{ status: failed ? "failed" : "passed", failureMessages: messages }] }] });
  const current = parseTestRun("C7-L", result(0), report(0, []));
  const old = parseTestRun("C7-L", result(1), report(1, ["expect(received).toBe(expected) Expected: 0 Received: 3"]));
  expect(regressionValid(old, current)).toBe(true);
  expect(regressionValid(current, current)).toBe(false);
  expect(regressionValid(parseTestRun("C7-L", result(1), ""), current)).toBe(false);
  expect(regressionValid(parseTestRun("C7-L", result(1), report(1, ["Cannot find module ./new-helper"])), current)).toBe(false);
});
test("Bun JUnit 回归识别断言失败，不把跳过当成通过", () => {
  const old = parseTestRun("C7-O", { exitCode: 1, stdout: "", stderr: "Expected: 500 Received: 409" }, '<testsuite><testcase name="status"><failure>Expected: 500</failure></testcase></testsuite>');
  const current = parseTestRun("C7-O", { exitCode: 0, stdout: "", stderr: "" }, '<testsuite><testcase name="status" /></testsuite>');
  expect(regressionValid(old, current)).toBe(true);
  const skipped = parseTestRun("C7-O", { exitCode: 0, stdout: "", stderr: "" }, '<testsuite><testcase name="status"><skipped/></testcase></testsuite>');
  expect(regressionValid(old, skipped)).toBe(false);
});
test("环境分类只看最终生成请求，不因曾经出现 429 覆盖后续正常请求失败", () => {
  const request = { kind: "request", data: { path: "/v1/messages" } };
  const limit = { kind: "response_headers", data: { status: 429 } };
  expect(classifyExecution("product_error", [request, limit])).toBe("environment_indeterminate");
  expect(classifyExecution("completed", [request, limit])).toBe("completed");
  expect(classifyExecution("product_error", [request, limit, request, { kind: "response_headers", data: { status: 200 } }])).toBe("unclassified_failure");
  expect(classifyExecution("budget_exhausted", [request, limit])).toBe("candidate_unfinished");
  expect(classifyExecution("product_error", [request, { kind: "response_headers", data: { status: 400 } }])).toBe("unclassified_failure");
});
