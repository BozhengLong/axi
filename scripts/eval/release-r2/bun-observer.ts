// 观察真实Bun测试和matcher调用，补足JUnit把普通Error标成AssertionError的缺口。
// 保留原生测试调度与matcher；不从错误文本猜测断言来源。
import * as native from 'bun:test';
import { mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import nodeAssert from 'node:assert';
import strictAssert from 'node:assert/strict';

const output = process.env.AXI_BUN_ASSERTIONS_PATH;
if (!output) throw Error('AXI_BUN_ASSERTIONS_PATH required');
const actualExpect = native.expect;
const actualTest = native.test;
const actualIt = native.it;
const contexts = new AsyncLocalStorage<{ id: number; name: string; assertions: number }>();
const assertionErrors = new WeakMap<object, number>();
const customErrors = new WeakSet<object>();
let sequence = 0;
const emit = (value: object) => appendFileSync(output, JSON.stringify(value) + '\n');
const objectError = (value: unknown): value is object => value !== null && (typeof value === 'object' || typeof value === 'function');
const customFailure = (error: unknown) => { if (objectError(error)) customErrors.add(error); throw error; };
const assertionFailure = (error: unknown, matcher: string) => {
  const assertion = objectError(error) && !customErrors.has(error);
  if (assertion && contexts.getStore()) assertionErrors.set(error, contexts.getStore()!.id);
  emit({ kind: 'matcher-failure', context: contexts.getStore()?.id, matcher, assertion });
  throw error;
};
function expectation(value: object): object {
  return new Proxy(value, {
    get(target, key) {
      const child = Reflect.get(target, key, target);
      if (key === 'not' || key === 'resolves' || key === 'rejects') return expectation(child);
      if (typeof child !== 'function') return child;
      return (...args: unknown[]) => {
        const context = contexts.getStore();
        if (context) context.assertions++;
        try {
          const result = Reflect.apply(child, target, args);
          if (result && typeof result.then === 'function') return result.then((v: unknown) => v, (e: unknown) => assertionFailure(e, String(key)));
          return result;
        } catch (error) { return assertionFailure(error, String(key)); }
      };
    },
  });
}
const observedExpect = new Proxy(actualExpect, {
  apply(target, thisArg, args) { return expectation(Reflect.apply(target, thisArg, args)); },
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== 'extend') return typeof value === 'function' ? value.bind(target) : value;
    return (matchers: Record<string, (...args: unknown[]) => unknown>) => {
      const wrapped = Object.fromEntries(Object.entries(matchers).map(([name, matcher]) => [name, function(this: unknown, ...args: unknown[]) {
        try {
          const result = Reflect.apply(matcher, this, args);
          if (result && typeof (result as any).then === 'function') return (result as Promise<unknown>).catch(customFailure);
          return result;
        } catch (error) { return customFailure(error); }
      }]));
      return Reflect.apply(value, target, [wrapped]);
    };
  },
});
const registrations = new WeakMap<Function, Function>();
function registration(fn: Function, parameterized = false): any {
  const wrapped = new Proxy(fn, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? registration(value, parameterized || key === 'each') : value;
    },
    apply(target, thisArg, args) {
      thisArg = (typeof thisArg === 'function' && registrations.get(thisArg)) || thisArg;
      const index = args.findIndex((arg, i) => typeof arg === 'function' && (i > 0 || args.length === 1));
      if (index < 0) {
        const result = Reflect.apply(target, thisArg, args);
        return typeof result === 'function' ? registration(result, parameterized) : result;
      }
      const callback = args[index];
      const name = typeof args[0] === 'string' ? args[0] : callback.name || '(anonymous)';
      const invoke = (receiver: unknown, parameters: unknown[]) => {
          const body = callback;
          const context = { id: ++sequence, name, assertions: 0 };
          return contexts.run(context, () => {
            emit({ kind: 'test-start', ...context });
            let ended = false;
            const finish = (error?: unknown, failed = false) => {
              if (!ended) {
                ended = true;
                emit({ kind: 'test-end', ...context, passed: !failed, assertionFailure: objectError(error) && assertionErrors.get(error) === context.id && !customErrors.has(error), errorName: (error as any)?.name });
              }
            };
            const callbackStyle = !parameterized && body.length > 0 && typeof parameters[0] === 'function';
            if (callbackStyle) {
              const done = parameters[0];
              parameters = [(error?: unknown) => { finish(error, Boolean(error)); return done(error); }, ...parameters.slice(1)];
            }
            try {
              const result = Reflect.apply(body, receiver, parameters);
              if (result && typeof result.then === 'function') return result.then((value: unknown) => { finish(); return value; }, (error: unknown) => { finish(error, true); throw error; });
              if (!callbackStyle) finish();
              return result;
            } catch (error) { finish(error, true); throw error; }
          });
      };
      // Bun要求可直接调用的JS函数作为测试体，不能传Function Proxy。
      const observed = callback.length > 0 && !parameterized
        ? function(this: unknown, done: unknown) { return invoke(this, [done]); }
        : function(this: unknown, ...parameters: unknown[]) { return invoke(this, parameters); };
      const replaced = args.slice();
      replaced[index] = observed;
      return Reflect.apply(target, thisArg, replaced);
    },
  });
  registrations.set(wrapped, fn);
  return wrapped;
}
const observedTest = registration(actualTest), observedIt = registration(actualIt);
mock.module('bun:test', () => ({ ...native, expect: observedExpect, test: observedTest, it: observedIt }));
for (const [key, before, after] of [['expect', actualExpect, observedExpect], ['test', actualTest, observedTest], ['it', actualIt, observedIt]] as const) {
  if ((globalThis as any)[key] === before) (globalThis as any)[key] = after;
}
// Node assert的错误还需真实AssertionError实例，普通Error伪造code不算。
function observeAssert(api: any): any {
  const proxy = new Proxy(api, {
    apply(target, receiver, args) { return invokeAssert(target, receiver, args); },
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'strict') return target === strictAssert ? proxy : observeAssert(strictAssert);
      if (key === 'AssertionError' || typeof value !== 'function') return value;
      return (...args: unknown[]) => invokeAssert(value, target, args);
    },
  });
  return proxy;
}
function invokeAssert(fn: Function, receiver: unknown, args: unknown[]): any {
  const context = contexts.getStore();
  if (context) context.assertions++;
  const failed = (error: unknown) => {
    if (error instanceof nodeAssert.AssertionError && context) assertionErrors.set(error, context.id);
    emit({kind:'node-assert-failure',context:context?.id,assertion:error instanceof nodeAssert.AssertionError});
    throw error;
  };
  try {
    const result = Reflect.apply(fn, receiver, args);
    return result && typeof result.then === 'function' ? result.then((value: unknown) => value, failed) : result;
  } catch (error) { return failed(error); }
}
for (const [name, api] of [['node:assert', nodeAssert], ['node:assert/strict', strictAssert], ['assert', nodeAssert], ['assert/strict', strictAssert]] as const) {
  const observed = observeAssert(api);
  mock.module(name, () => Object.assign(Object.fromEntries(Object.keys(api).map(key => [key, observed[key]])), {default:observed}));
}
emit({ kind: 'observer-start', version: 1, bun: Bun.version });
