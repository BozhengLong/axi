// 只有控制器可开启下一轮；token 计数与生成请求分别记账。
export class RequestBudget {
  round = 1;
  requests = 0;
  generationRequests = 0;
  countRequests = 0;
  roundRequests = 0;
  constructor(readonly maxRounds = 1, readonly maxPerRound = 50, readonly maxTotal = 50) {
    if (![maxRounds, maxPerRound, maxTotal].every(x => Number.isInteger(x) && x > 0)) throw new Error("invalid request budget");
  }
  consume(countOnly: boolean): boolean {
    this.requests++;
    if (countOnly) { this.countRequests++; return true; }
    this.generationRequests++; this.roundRequests++;
    return this.roundRequests <= this.maxPerRound && this.generationRequests <= this.maxTotal;
  }
  advance(expectedRound: number): void {
    if (expectedRound !== this.round || this.round >= this.maxRounds) throw new Error("invalid round transition");
    this.round++; this.roundRequests = 0;
  }
}
