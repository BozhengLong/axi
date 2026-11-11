import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, constants } from "node:fs";
import { join } from "node:path";
import type { RecordLog } from "./api/types.ts";

export class SessionLog {
  readonly path: string;
  private fd: number;

  constructor(cwd: string) {
    const directory = join(cwd, ".axi", "logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // 忽略规则跟随日志目录工作，不能依赖 Axi 仓库根目录的 .gitignore。
    // O_NOFOLLOW 防止把本目录的排除文件链接到其他项目配置。
    const ignore = openSync(join(directory, ".gitignore"), constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const existing = readFileSync(ignore, "utf8");
      const rules = existing.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
      if (rules.at(-1) !== "*") appendFileSync(ignore, `${existing && !existing.endsWith("\n") ? "\n" : ""}# Axi 本地会话日志不进入 Git\n*\n`);
    } finally { closeSync(ignore); }
    this.path = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.jsonl`);
    this.fd = openSync(this.path, "wx", 0o600);
  }

  // 只记录请求体，不记录认证头。原始内容留在带排除规则的本地目录。
  record: RecordLog = (kind, data) => {
    appendFileSync(this.fd, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n");
  };

  close(): void { closeSync(this.fd); }
}
