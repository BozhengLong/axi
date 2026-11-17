// R3只按已冻结截止时间准入请求。次数用于审计，不参与停止判定。
export interface RunPolicy {
  version: 'r3';
  limitMode: 'unlimited';
  requestLimit: null;
  executionDeadline: number;
}

export function validatePolicy(value: unknown): RunPolicy {
  if (!value || typeof value !== 'object') throw Error('缺少R3运行策略');
  const p = value as RunPolicy;
  if (p.version !== 'r3' || p.limitMode !== 'unlimited' || p.requestLimit !== null ||
      !Number.isSafeInteger(p.executionDeadline) || p.executionDeadline <= 0) throw Error('R3运行策略无效');
  return {version: 'r3', limitMode: 'unlimited', requestLimit: null, executionDeadline: p.executionDeadline};
}

export class RequestMeter {
  readonly policy: RunPolicy;
  readonly monotonicDeadline: number;
  receivedGeneration = 0;
  receivedCountTokens = 0;
  forwardedGeneration = 0;
  forwardedCountTokens = 0;
  blockedGeneration = 0;
  blockedCountTokens = 0;
  revoked = false;

  constructor(policy: unknown, private mono = () => performance.now(), wall = Date.now()) {
    this.policy = validatePolicy(policy);
    // 固定两种时钟的映射；运行中回拨系统时间不能重新获得执行窗口。
    this.monotonicDeadline = mono() + Math.max(0, this.policy.executionDeadline - wall);
  }

  remainingMs(): number { return Math.max(0, this.monotonicDeadline - this.mono()); }
  revoke(): void { this.revoked = true; }
  admit(countTokens: boolean): {allowed: boolean; reason: 'allowed' | 'revoked' | 'deadline'} {
    if (countTokens) this.receivedCountTokens++; else this.receivedGeneration++;
    const reason = this.revoked ? 'revoked' : this.remainingMs() <= 0 ? 'deadline' : 'allowed';
    if (reason === 'allowed') {
      if (countTokens) this.forwardedCountTokens++; else this.forwardedGeneration++;
    } else if (countTokens) this.blockedCountTokens++; else this.blockedGeneration++;
    return {allowed: reason === 'allowed', reason};
  }

  snapshot() {
    return {...this.policy, receivedGeneration: this.receivedGeneration, receivedCountTokens: this.receivedCountTokens,
      forwardedGeneration: this.forwardedGeneration, forwardedCountTokens: this.forwardedCountTokens,
      blockedGeneration: this.blockedGeneration, blockedCountTokens: this.blockedCountTokens, revoked: this.revoked,
      remainingMs: this.remainingMs()};
  }
}
