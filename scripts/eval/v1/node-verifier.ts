// Node 24 在 process.exit() 时可能等待 V8 后台编译而死锁。
// 只用于独立 tsc。AVA 会将 execArgv 传给 Worker，不能接受这些 V8 选项。
// 不改变被测 CLI、候选命令、检查内容或超时判据。
// 依据：docs/verification/2026-11-12-v1-completion.md。
export const TYPECHECK_NODE = ['node', '--no-concurrent-sparkplug', '--no-concurrent-recompilation'] as const;
