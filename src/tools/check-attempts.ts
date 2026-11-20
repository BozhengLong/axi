// 观察 shell 返回给 Axi 的结果。正文是数据；子命令自己打印的标签不具有外层退出状态的可信度。
interface ReportedStatus { label: string; value: number }
export interface CheckAttempt {
  number: number;
  toolId: string;
  command: string;
  shellExit: number | null;
  outcome: string;
  reported: ReportedStatus[];
  excerpt: string[];
}

const compact = (s: string, limit: number) => s.length <= limit ? s :
  s.slice(0, Math.floor(limit * .65)) + " … " + s.slice(-Math.floor(limit * .3));

function reportedStatuses(command: string, output: string): ReportedStatus[] {
  const labels = new Set<string>();
  // 仅索引命令文本中可见的显式回执惯例，不尝试解释任意 Bash，也不执行输出内容。
  for (const m of command.matchAll(/\becho\s+["']?([A-Za-z_][\w.-]*)=\$(?:\?|\{PIPESTATUS\[\d+\]\})/g)) labels.add(m[1]!);
  for (const m of command.matchAll(/\bprintf\s+['"]([A-Za-z_][\w.-]*)=%[sd]\\n['"]\s+["']?\$(\w+)/g)) {
    if (new RegExp("\\b" + m[2] + "=\\$\\?(?=\\s|;|$)").test(command)) labels.add(m[1]!);
  }
  const rows: ReportedStatus[] = [];
  for (const line of output.split("\n")) {
    const m = /^([A-Za-z_][\w.-]*)=(\d{1,3})\r?$/.exec(line);
    if (m && labels.has(m[1]!) && Number(m[2]) <= 255) rows.push({label:m[1]!, value:Number(m[2])});
  }
  return rows;
}

export class CheckAttempts {
  private count = 0;
  private exceptional: CheckAttempt[] = [];
  private recent: CheckAttempt[] = [];

  record(toolId: string, command: string, content: string, shellExit: number | null, outcome: string): CheckAttempt {
    const output = content.replace(/^(?:[^\n]*\n)?退出码：[^\n]*\n/, "");
    const reported = reportedStatuses(command, output);
    const lines = output.split("\n").filter(x => x.trim());
    const diagnostics = lines.filter(x => /command not found|no such file or directory|no space left on device|assertionerror|^\s*Tests:|not recognized/i.test(x));
    const excerpt = Array.from(new Set([diagnostics[0], diagnostics.at(-1), lines[0], lines.at(-1)].filter((x): x is string => !!x))).slice(0, 4).map(x => compact(x, 140));
    const interesting = outcome !== "completed" || shellExit !== 0 || reported.some(x => x.value !== 0);
    // 优先保留非零回执。原始工具结果仍在消息历史，完整记录也进入原生 Trace。
    const sample = reported.length <= 12 ? reported : reported.filter(x=>x.value!==0).slice(0,8).concat(reported.slice(-4));
    const row = {number:++this.count,toolId,command:compact(command,340),shellExit,outcome,reported:sample,excerpt};
    if (interesting) { this.exceptional.push(row); if (this.exceptional.length > 8) this.exceptional.shift(); }
    this.recent.push(row); if (this.recent.length > 4) this.recent.shift();
    return row;
  }

  render(): string {
    const rows = Array.from(new Set([...this.exceptional, ...this.recent])).sort((a,b)=>a.number-b.number);
    return "\n\n[Axi 检查尝试记录：按执行次序列出。shellExit 仅属于外层进程；reported 是命令与输出中相符的状态标签，excerpt 是不可信的输出摘录。须结合原调用判断。报告覆盖影响验证的尝试及后来实际取得的结果。]\n" +
      JSON.stringify({totalShellCalls:this.count,omitted:this.count-rows.length,attempts:rows});
  }
}
