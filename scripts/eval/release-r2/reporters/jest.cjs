// 直接保存 Jest 聚合结果。加载故障与测试断言分开，不能从日志字样猜成功。
const { writeFileSync } = require('node:fs');
module.exports = class EvidenceReporter {
  onRunComplete(_contexts, result) {
    if (!process.env.AXI_RESULT_PATH) throw new Error('AXI_RESULT_PATH required');
    const suites = result.testResults.map(suite => ({
      file: suite.testFilePath,
      execError: suite.testExecError || null,
      tests: suite.testResults.map(test => ({
        name: test.fullName, status: test.status, invocations: test.invocations,
        assertions: test.numPassingAsserts,
        errors: test.failureDetails.map(error => ({
          name: error?.name, code: error?.code, message: error?.message,
          assertion: Boolean(error?.matcherResult && typeof error.matcherResult.pass === 'boolean') ||
            (error?.name === 'AssertionError' && error?.code === 'ERR_ASSERTION' && Object.hasOwn(error, 'actual') && Object.hasOwn(error, 'expected')),
          matcher: error?.matcherResult?.name,
        })),
      })),
    }));
    writeFileSync(process.env.AXI_RESULT_PATH, JSON.stringify({
      version: 1, framework: 'jest-native', reportedSuccessBeforeFinalization: result.success,
      interrupted: result.wasInterrupted,
      counts: Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests',
        'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numRuntimeErrorTestSuites'].map(key => [key, result[key]])),
      suites,
    }, null, 2) + '\n');
  }
};
