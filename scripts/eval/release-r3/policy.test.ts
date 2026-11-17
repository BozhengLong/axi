import {expect, test} from 'bun:test';
import {RequestMeter, validatePolicy} from './policy.ts';
import {RequestBudget} from '../container/budget.ts';
const policy = {version: 'r3', limitMode: 'unlimited', requestLimit: null, executionDeadline: 10000};

test('R3默认不能回落50次；大于旧总3136仍准入，记录所有请求', () => {
  const m = new RequestMeter(policy, () => 0, 0);
  for (let i = 0; i < 5000; i++) expect(m.admit(false).allowed).toBe(true);
  expect(m.admit(true).allowed).toBe(true);
  expect(m.snapshot()).toMatchObject({requestLimit: null, receivedGeneration: 5000, forwardedGeneration: 5000, receivedCountTokens: 1, forwardedCountTokens: 1, blockedGeneration: 0});
});

test('截止覆盖生成和count_tokens，撤销阻止请求，时钟回拨不延长窗口', () => {
  let mono = 200;
  const m = new RequestMeter(policy, () => mono, 9000);
  expect(m.remainingMs()).toBe(1000);mono = 1200;
  expect(m.admit(false)).toEqual({allowed: false, reason: 'deadline'});
  expect(m.admit(true)).toEqual({allowed: false, reason: 'deadline'});
  expect(m.snapshot()).toMatchObject({blockedGeneration: 1, blockedCountTokens: 1, forwardedGeneration: 0});
  const revoked = new RequestMeter(policy, () => 0, 0);revoked.revoke();
  expect(revoked.admit(false)).toEqual({allowed: false, reason: 'revoked'});
});

test('缺策略、数字上限和无效截止拒绝，旧有限策略仍在第51次阻止', () => {
  for (const p of [undefined, {}, {...policy, requestLimit: 50}, {...policy, executionDeadline: Infinity}, {...policy, executionDeadline: 1.2}, {...policy, version: 'r2'}]) expect(() => validatePolicy(p)).toThrow();
  const old = new RequestBudget();
  for (let i = 0; i < 50; i++) expect(old.consume(false)).toBe(true);
  expect(old.consume(false)).toBe(false);
  const late = new RequestMeter(policy, () => 100, 10001);expect(late.admit(false).allowed).toBe(false);
});
