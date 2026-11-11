import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docker, save } from "../core.ts";
import { IMAGE, STUDY } from "./settings.ts";

const pilot = JSON.parse(readFileSync(join(STUDY, "pilot-batch.json"), "utf8"));
const oldImage = JSON.parse(readFileSync(join(pilot.directory, "manifest.json"), "utf8")).image;
const newImage = (await docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"])).stdout.trim();
const oldCollector = join(STUDY, "pilot-files-collector.ts");
writeFileSync(oldCollector, readFileSync(join(pilot.directory, "source-snapshot/scripts/eval/container/files.ts")), { mode: 0o444 });
const script = `
import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
mkdirSync('/task/.axi/logs',{recursive:true});
const original=Buffer.from(JSON.stringify({type:'synthetic-trace',data:'x'.repeat(40*1024*1024)})+'\\n');
writeFileSync('/task/.axi/logs/probe.jsonl',original);
const child=Bun.spawn(['bun','/opt/eval/files.ts','logs'],{stdout:'pipe',stderr:'pipe'});
const result=JSON.parse(await new Response(child.stdout).text());
const exitCode=await child.exited;
const entry=result.files['axi-session/probe.jsonl'];
const restored=entry?Buffer.from(entry.data,'base64'):Buffer.alloc(0);
const hash=x=>createHash('sha256').update(x).digest('hex');
console.log(JSON.stringify({exitCode,bytes:original.length,collected:restored.length,issues:result.issues,expectedSha256:hash(original),actualSha256:hash(restored),equal:original.equals(restored)}));
`;
const results = [];
for (const kind of ["old", "new"]) {
  const override = kind === "old" ? ["--mount", `type=bind,src=${oldCollector},dst=/opt/eval/files.ts,readonly`] : [];
  const output = await docker(["run", "--rm", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop=ALL", "--memory", "1g", "--cpus", "2", "--tmpfs", "/task:rw,nosuid,size=128m,mode=1777", ...override, "--entrypoint", "bun", newImage, "-e", script], undefined, true, 60000);
  if (output.exitCode) throw new Error(output.stderr);
  results.push({ kind, image: newImage, originalPilotImage: oldImage, collectorSource: kind === "old" ? "pilot source snapshot" : "image", ...JSON.parse(output.stdout) });
}
const passed = !results[0]!.equal && results[0]!.issues.length === 1 && results[1]!.equal && results[1]!.issues.length === 0;
save(join(STUDY, "native-limit-preflight.json"), { passed, results });
console.log(JSON.stringify({ passed, results }));
if (!passed) throw new Error("原生日志上限校验失败");
