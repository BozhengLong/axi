export type ReviewMode = "auto" | "off";
export type TaskPhase = "work" | "review";

export class RequestBudgetError extends Error {}

// 每次实际调用fetch（含重试）共用此预算，不按成功响应数计算。
export class GenerationBudget {
  private work = 0;
  private review = 0;
  private current: TaskPhase = "work";
  constructor(readonly mode: ReviewMode) {}
  get phase(): TaskPhase { return this.current; }
  get used(): number { return this.work + this.review; }
  get remaining(): number { return Math.min(50 - this.used, this.current === "review" ? 10 - this.review : (this.mode === "auto" ? 40 : 50) - this.work); }
  snapshot() { return { mode: this.mode, phase: this.current, workRequests: this.work, reviewRequests: this.review, requests: this.used, remaining: this.remaining }; }
  consume(): void {
    if (this.remaining <= 0) throw new RequestBudgetError(`实际生成请求预算已用尽：${this.current === "review" ? "复核" : "工作"}阶段，共${this.used}次；本轮未完成。`);
    if (this.current === "work") this.work++; else this.review++;
  }
  beginReview(): void {
    if (this.mode !== "auto" || this.current !== "work") throw new Error("不能重复或在关闭模式进入复核");
    this.current = "review";
  }
}

export function reviewPrompt(reason: "draft" | "work_budget", budget: GenerationBudget): string {
  return `[Axi自动收尾复核；不是用户的新指令。原因：${reason === "draft" ? "已有待复核初稿" : "正常工作阶段预算已到，当前仍可能未完成"}。复核最多还可发出${budget.remaining}次实际生成请求，重试也计入。]
继续遵守用户原任务、拒绝理由、文件保护及权限要求。先核对公开契约、实际diff、已有检查和未完成项；优先处理正确性及保护要求，再处理可选风格问题。
检查本次新增资源或异步工作的责任归属，以及它们在完成、拒绝、取消、丢弃和清理后由谁负责；只检查与改动相关的路径。
核查“旧问题”“与本次无关”“不会影响调用方”等重大风险判断。使用同输入、同环境的可信基线与当前版本对照；用户有脏改时，Git HEAD不一定是接手版本，不能reset或覆盖用户文件。可在隔离副本验证，基线不可得就明确写未验证，不把推测当作结论。
已有且仍适用的验证证据可以复用。新增风险缺少证据时补对应验证。若确认违反当前契约，在剩余预算内修复并复验；来不及则明确未完成，不能仅列为已知风险便称完整交付。
最后一次相关修改后重跑受影响检查，保留检查本身退出码。最终报告分别说明实际通过、实际失败、未执行及未验证的风险。复核只有这一次，不启动额外agent，不绕过拒绝，不重复已完成的副作用。`;
}
