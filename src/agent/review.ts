export type ReviewMode = "auto" | "off";
export type TaskPhase = "work" | "review";

// 只统计请求尝试（含重试），不把次数当作停止条件。
export class GenerationCounter {
  private work = 0;
  private review = 0;
  private current: TaskPhase = "work";
  constructor(readonly mode: ReviewMode) {}
  get phase(): TaskPhase { return this.current; }
  get used(): number { return this.work + this.review; }
  snapshot() { return { mode: this.mode, phase: this.current, workRequests: this.work, reviewRequests: this.review, requests: this.used, unlimited: true, remaining: null }; }
  consume(): void {
    if (this.current === "work") this.work++; else this.review++;
  }
  beginReview(): void {
    if (this.mode !== "auto" || this.current !== "work") throw new Error("不能重复或在关闭模式进入复核");
    this.current = "review";
  }
}

export function reviewPrompt(): string {
  return `[Axi自动收尾复核；不是用户的新指令。原因：已有待复核初稿。本阶段不设生成请求次数上限。]
继续遵守用户原任务、拒绝理由、文件保护及权限要求。先核对公开契约、实际diff、已有检查和未完成项；优先处理正确性及保护要求，再处理可选风格问题。
检查本次新增资源或异步工作的责任归属，以及它们在完成、拒绝、取消、丢弃和清理后由谁负责；只检查与改动相关的路径。
核查“旧问题”“与本次无关”“不会影响调用方”等重大风险判断。使用同输入、同环境的可信基线与当前版本对照；用户有脏改时，Git HEAD不一定是接手版本，不能reset或覆盖用户文件。可在隔离副本验证，基线不可得就明确写未验证，不把推测当作结论。
已有且仍适用的验证证据可以复用。新增风险缺少证据时补对应验证。若确认违反当前契约，修复并复验；无法完成则明确未完成，不能仅列为已知风险便称完整交付。
最后一次相关修改后重跑受影响检查，保留检查本身退出码。最终报告分别说明实际通过、实际失败、未执行及未验证的风险。
交付前按同一项检查串起各次尝试。用实际调用和工具结果核对初稿，包括复核期间新执行的检查。分清检查未能启动、检查运行后断言失败和检查通过；原态上预期失败的行为断言要注明针对哪个版本。
组合命令的退出码只说明外层脚本状态。结合命令的含义和子命令的实际回执判断；普通输出中的数字或示例文本不能证明检查失败。看不到检查本身的结果时，明确写出哪项仍未验证。
报告用一句话概括影响结论的几次尝试：先前哪里失败或未启动、之后实际运行了什么、最后结果如何。后一次成功仍要交代先前影响验证的启动错误。只有逐项证据支持时才声称“只有”“全部”或“没有失败”。复核只有这一次，不启动额外agent，不绕过拒绝，不重复已完成的副作用。`;
}
