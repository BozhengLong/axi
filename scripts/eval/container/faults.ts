// 连接故障属于请求传输证据。由 CLI 自行决定重试；它不能永久污染后续轮次。
// 未识别的故障仍按致命处理，避免意外放松预算或授权配对。
export const fatalFaults = (faults: readonly string[]): string[] => faults.filter(fault => fault !== 'upstream_connection');
