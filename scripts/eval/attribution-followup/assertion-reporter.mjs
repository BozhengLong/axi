import {tap} from 'node:test/reporters';
import {inspect} from 'node:util';

// Node 无法序列化 Promise 等断言操作数时，只保留 cause 的 inspect 文本。
// 从原生失败事件取证，再交给原 TAP 格式器；不改变测试执行或隔离方式。
export default async function* report(source) {
	const failures = [];
	async function* observed() {
		for await (const event of source) {
			if (event.type === 'test:fail') {
				const error = event.data.details.error;
				const cause = error?.cause;
				const object = cause !== null && typeof cause === 'object';
				const display = inspect(cause, {colors: false});
				const structured = object && cause.name === 'AssertionError' && cause.code === 'ERR_ASSERTION';
				const serialized = object && Object.getPrototypeOf(cause) === null
					&& Object.getOwnPropertyNames(cause).length === 0
					&& typeof cause[inspect.custom] === 'function'
					&& /^AssertionError \[ERR_ASSERTION\]:/.test(display)
					&& /\n\s+code: 'ERR_ASSERTION',?\n/.test(display);
				failures.push({name: event.data.name, file: event.data.file, line: event.data.line,
					failureType: error?.failureType, assertion: error?.failureType === 'testCodeFailure' && (structured || serialized),
					origin: structured ? 'structured-cause' : serialized ? 'serialized-cause' : 'other', display});
			}
			yield event;
		}
	}
	yield* tap(observed());
	yield '# AXI_TEST_ASSERTIONS_V1 ' + JSON.stringify({version: 1, failures}) + '\n';
}
