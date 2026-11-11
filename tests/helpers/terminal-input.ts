import { Terminal } from "../../src/ui/terminal.ts";
import { confirmCommand } from "../../src/ui/permission.ts";

const ui = new Terminal();
const mode = process.argv[2];
async function confirm() {
  const result = await confirmCommand("printf not_executed", "/synthetic", ui.read, ui.write, new AbortController().signal);
  ui.write(`RESULT=${JSON.stringify(result)}\n`);
  ui.close();
}
if (mode === "interrupt") {
  const controller = new AbortController();
  ui.onInterrupt = () => controller.abort();
  try { await ui.read("FIRST> ", controller.signal); }
  catch { ui.write("ABORTED\n"); }
  await confirm();
} else {
  ui.write("READY\n");
  // 测试侧用文件通知开始确认，避免 Bun 1.3.14 在本机处理 SIGUSR1 时崩溃。
  while (!(await Bun.file(process.argv[3]!).exists())) await Bun.sleep(5);
  await confirm();
}
