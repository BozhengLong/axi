import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { RecordLog } from "./api/types.ts";

export class SessionLog {
  readonly path: string;
  private fd: number;

  constructor(cwd: string) {
    const directory = join(cwd, ".axi", "logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.jsonl`);
    this.fd = openSync(this.path, "wx", 0o600);
  }

  // 只记录请求体，不记录认证头。原始内容留在被 Git 忽略的本地目录。
  record: RecordLog = (kind, data) => {
    appendFileSync(this.fd, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n");
  };

  close(): void { closeSync(this.fd); }
}
