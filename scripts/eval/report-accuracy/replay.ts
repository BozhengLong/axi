// 每份回放只生成一次最终回答。工具定义与历史保留，两个版本都禁止继续调用工具。
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.umask(0o077);
const [studyArg, base, experiment] = process.argv.slice(2);
assert(studyArg && base && experiment);
const study = resolve(studyArg);
const read = (file: string) => JSON.parse(readFileSync(join(study, file), "utf8"));
const save = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 });
const load = (repo: string, module: string) => import(pathToFileURL(join(repo, module)).href);
const manifest = read("manifest.json");
for (const [name, hash] of Object.entries(manifest.files)) {
  assert.equal(new Bun.CryptoHasher("sha256").update(readFileSync(join(study, name))).digest("hex"), hash);
}
const prompts = read("prompts.json");
for (const [arm, repo] of Object.entries({baseline:base, experiment})) {
  assert.equal((await load(repo, "src/agent/review.ts")).reviewPrompt(), prompts[arm]);
}
const withAttempts = manifest.schema === "check-attempts-v1";
const pilot = withAttempts && process.argv[5] === "pilot";
if (withAttempts && !pilot) assert(read("pilot-grade.json").reviewed === true, "先审查独立试报");
const outputs = join(study, pilot ? "pilot-trials" : "trials"), blind = join(study, pilot ? "pilot-answer" : "blind");
mkdirSync(outputs); mkdirSync(blind);
const {APIClient} = await load(base, "src/api/client.ts");
const config = (await load(base, "src/config.ts")).loadConfig();
assert.equal(config.model,"claude-opus-5-5");
let completed = 0;
const schedule = pilot ? [{case:"history", arm:"experiment", blind:"pilot-c7-l"}] : read("key.json").order;
for (const trial of schedule) {
  const inputDir = withAttempts && trial.arm === "experiment" ? "inputs-experiment/" : "inputs/";
  const body = read(inputDir + trial.case + ".json");
  const matches = body.messages.filter((m: any) => m.role === "user" && m.content === prompts.baseline);
  assert.equal(matches.length, 1); matches[0].content = prompts[trial.arm];
  const dir = join(outputs, trial.blind); mkdirSync(dir);
  const started = new Date().toISOString();
  let attempt = 0;
  const client = new APIClient(config, body.system, {
    record(kind: string, data: unknown) {
      appendFileSync(join(dir, "events.jsonl"), JSON.stringify({time:new Date().toISOString(),kind,data}) + "\n");
    },
    async fetch(url: string, init: RequestInit) {
      assert.deepEqual(JSON.parse(String(init.body)), body);
      const wire = JSON.stringify({...body, tool_choice: {type:"none"}});
      const prefix = join(dir, "http-" + (++attempt));
      writeFileSync(prefix + ".request.json", wire, {flag:"wx",mode:0o600});
      const response = await fetch(url, {...init, body:wire});
      save(prefix + ".headers.json", {status:response.status, contentType:response.headers.get("content-type"), requestId:response.headers.get("request-id"), retryAfter:response.headers.get("retry-after")});
      assert(response.body);
      const observed = response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
        transform(chunk, controller) { appendFileSync(prefix + ".body",chunk); controller.enqueue(chunk); }
      }));
      return new Response(observed, {status:response.status, headers:response.headers});
    }
  });
  try {
    const result = await client.call(body.messages, {effort:"medium", signal:new AbortController().signal});
    const answer = result.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
    save(join(dir,"result.json"), {started,finished:new Date().toISOString(),stopReason:result.stopReason,usage:result.usage,attempts:attempt,answer});
    save(join(blind,trial.blind+".json"),{id:trial.blind,case:trial.case,answer,stopReason:result.stopReason});
    console.log(JSON.stringify({completed:++completed, of:schedule.length}));
  } catch(error) {
    save(join(dir,"failure.json"),{started,finished:new Date().toISOString(),attempts:attempt,error:String(error).replaceAll(config.apiKey,"[redacted]")});
    throw error;
  }
}
