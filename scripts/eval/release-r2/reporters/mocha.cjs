// Mocha 的事件和计数直接来自 Runner；不解析人类可读的错误文字。
const { writeFileSync } = require('node:fs')
const { AssertionError } = require('node:assert')

module.exports = class EvidenceReporter {
  constructor (runner) {
    const tests = [], failures = [], pending = []
    runner.on('test end', test => tests.push({ name: test.fullTitle(), file: test.file, state: test.state, pending: test.pending }))
    runner.on('pending', test => pending.push({ name: test.fullTitle(), file: test.file }))
    runner.on('fail', (test, error) => failures.push({ name: test.fullTitle(), file: test.file,
      hook: test.type === 'hook', error: { name: error.name, code: error.code, message: error.message,
        assertion: error instanceof AssertionError, actual: String(error.actual), expected: String(error.expected) } }))
    runner.once('end', () => {
      if (!process.env.AXI_RESULT_PATH) throw new Error('AXI_RESULT_PATH required')
      writeFileSync(process.env.AXI_RESULT_PATH, JSON.stringify({ version: 1, framework: 'mocha',
        stats: runner.stats, tests, pending, failures }, null, 2) + '\n')
    })
  }
}
