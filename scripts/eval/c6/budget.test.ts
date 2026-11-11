import { test, expect } from "bun:test";
import { RequestBudget } from "../container/budget.ts";

test("逐轮预算重置但总预算不能绕过；计数请求单列", () => {
  const b = new RequestBudget(3, 2, 5);
  for (let i = 0; i < 5; i++) expect(b.consume(true)).toBe(true);
  expect(b.consume(false)).toBe(true); expect(b.consume(false)).toBe(true);
  expect(() => b.advance(2)).toThrow();
  b.advance(1);
  expect(b.consume(false)).toBe(true); expect(b.consume(false)).toBe(true);
  b.advance(2);
  expect(b.consume(false)).toBe(true); expect(b.consume(false)).toBe(false);
  expect(b.countRequests).toBe(5); expect(b.generationRequests).toBe(6);
  expect(() => b.advance(3)).toThrow();
});

test("单轮预算到达后拒绝继续生成", () => {
  const b = new RequestBudget(3, 1, 3);
  expect(b.consume(false)).toBe(true); expect(b.consume(false)).toBe(false);
  expect(b.round).toBe(1);
});
