import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initialize, docker, control, save, ROOT, type Snapshot } from "../core.ts";
import { runAxi, runClaude } from "../adapters.ts";
import { fingerprint } from "../complex/fingerprint.ts";
import { writeTraceIndex } from "../trace.ts";
import { c6Runtime, capturePaused, patchPaused, helper, cleanup } from "./runtime.ts";
import { prepareWorkspace } from "./workspace.ts";
import { grade, type Grade } from "./grade.ts";
import { seedFiles, currentSeed, file, snapshotHash, hash } from "./task.ts";
import { STUDY, UPSTREAM_COMMIT, ROUND_MS, TRAJECTORY_MS, POLICY_PATH } from "./settings.ts";

const phase = process.argv[2];
if (!["smoke", "pilot", "formal"].includes(phase ?? "")) throw new Error("指定 smoke、pilot 或 formal");
if (!process.env.AXI_EVAL_IMAGE) throw new Error("必须明确设置 AXI_EVAL_IMAGE 为 C6 镜像");
const deadline = Number(process.env.AXI_C6_DEADLINE);
if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("AXI_C6_DEADLINE 必须是明确的未来 epoch 毫秒");
const calibration = JSON.parse(readFileSync(join(STUDY, "calibration.json"), "utf8"));
const continuity = JSON.parse(readFileSync(join(STUDY, "continuity-preflight.json"), "utf8"));
if (!calibration.complete || !calibration.results.every((x: any) => x.passed) || continuity.length !== 2 || !continuity.every((x: any) => x.passed)) throw new Error("前置校准未通过");
const preflight = JSON.parse(readFileSync(join(STUDY, "preflight-approved.json"), "utf8"));
if (!preflight.pass || !preflight.complete || (phase !== "smoke" && !preflight.live)) throw new Error("完整前置与真实连通性未通过");
const recovery = process.env.AXI_C6_RECOVERY_INCIDENT ? JSON.parse(readFileSync(process.env.AXI_C6_RECOVERY_INCIDENT, "utf8")) : undefined;
if (recovery && (phase !== "formal" || recovery.status !== "environment_indeterminate" || recovery.attempt !== 1 || ![1, 2, 3].includes(recovery.repeat) || !recovery.reason || !recovery.originalDirectory)) throw new Error("无效的环境事故补跑记录");
if (recovery) {
  const original = JSON.parse(readFileSync(join(recovery.originalDirectory, "manifest.json"), "utf8"));
  if (original.phase !== "formal" || original.sourceHash !== fingerprint().sourceHash || original.deadline !== new Date(deadline).toISOString()) throw new Error("补跑必须保持原正式源码与截止时间");
}
const batch = await initialize(), frozen = fingerprint(), results: any[] = [];
if (batch.image !== preflight.image) { await docker(["rm", "-f", batch.relay]); throw new Error("运行镜像与前置检查不一致"); }
for (const path of Object.keys(frozen.hashes)) {
  const target = join(batch.directory, "source-snapshot", path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, readFileSync(join(ROOT, path)), { mode: 0o600 });
}
const fullSchedule = (phase !== "formal" ? [["axi", "claude"]] : [["axi", "claude"], ["claude", "axi"], ["axi", "claude"]]) as ("axi" | "claude")[][];
const schedule = recovery ? [fullSchedule[recovery.repeat - 1]!] : fullSchedule;
const manifest = { batch: batch.id, phase, recovery, suite: "c6-real-v1", suiteRevision: 3, traceVersion: 2, upstream: UPSTREAM_COMMIT, created: new Date().toISOString(), deadline: new Date(deadline).toISOString(), model: "claude-opus-5-5", effort: "medium", image: batch.image, maxRoundMs: ROUND_MS, maxTrajectoryMs: TRAJECTORY_MS, maxRoundGenerationRequests: 50, maxTrajectoryGenerationRequests: 150, schedule, ...frozen, calibration, continuity, preflight };
save(join(batch.directory, "manifest.json"), manifest);
save(join(STUDY, `${phase}${recovery ? "-retry1" : ""}-batch.json`), { id: batch.id, directory: batch.directory });
let expectedCommit: string | undefined;
try {
  for (const [pairIndex, order] of schedule.entries()) {
    // 为完整配对与报告预留时间；不在截止前只给一方做题。
    if (Date.now() + TRAJECTORY_MS * 2 + 30 * 60_000 > deadline) { save(join(batch.directory, "deadline-stop.json"), { time: new Date().toISOString(), nextPair: pairIndex + 1 }); break; }
    if (recovery) writeFileSync(join(recovery.originalDirectory, `recovery-pair-${recovery.repeat}.claim`), JSON.stringify({ batch: batch.id, reason: recovery.reason }) + "\n", { flag: "wx", mode: 0o600 });
    for (const agent of order) {
      if (fingerprint().sourceHash !== frozen.sourceHash) throw new Error("本批冻结源码已改变");
      const repeat = recovery?.repeat ?? pairIndex + 1;
      const id = `${phase}-C6-r${repeat}-${agent}${recovery ? "-retry1" : ""}`;
      const mock = phase === "smoke" ? [1, 2, 3].map(round => ({ content: [{ type: "text", text: `模拟第 ${round} 轮交付。未实现功能，用于验证失败反馈与连续控制。` }], stopReason: "end_turn" })) : undefined;
      const runtime = await c6Runtime(batch, id, seedFiles(), mock);
      const rounds: { round: number; grade: Grade }[] = [], extras: Snapshot = {};
      let finalFiles: Snapshot = {}, watchdogBusy = false, paused = false, resourceFailure = "";
      const event = (kind: string, data: unknown) => appendFileSync(join(runtime.directory, "round-events.jsonl"), JSON.stringify({ time: new Date().toISOString(), trajectoryId: id, kind, data }) + "\n", { mode: 0o600 });
      const watchdog = setInterval(async () => {
        if (watchdogBusy || paused) return; watchdogBusy = true;
        try {
          const usage = await helper(batch.image, runtime.taskVolume!, ["du", "-sk", "/task"]);
          if (usage.exitCode === 0 && Number(usage.stdout.split(/\s+/)[0]) > 2 * 1024 * 1024) {
            resourceFailure = "workspace_disk_budget"; event("resource_limit", { limitBytes: 2 * 1024 ** 3 }); await docker(["kill", runtime.name], undefined, true);
          }
        } catch (error) { event("resource_observer_error", { error: String(error) }); }
        finally { watchdogBusy = false; }
      }, 10000);
      try {
        const commit = await prepareWorkspace(batch, runtime);
        if (expectedCommit && expectedCommit !== commit) throw new Error("配对初始 Git 提交不一致"); expectedCommit = commit;
        save(join(runtime.directory, "initial-files.json"), currentSeed());
        const prompts = ["请在 /task 完成 C6 第一轮任务。先读 c6/brief.md、c6/contract-r1.md、c6/environment.md、c6/protected-files.json 和 c6/initial-changes.md，再实现并实际验证。只执行本轮已公布要求，保留用户修改。最后用中文交付，不自行退出会话。", "", ""];
        const execution = await (agent === "axi" ? runAxi : runClaude)(batch, runtime, prompts, {
          maxMs: TRAJECTORY_MS, roundMaxMs: ROUND_MS,
          onRound: async index => {
            const round = index + 1;
            for (let attempt = 0; ; attempt++) {
              const state = await control(batch, "state", { id });
              if (!state.activeRequests) break;
              if (attempt >= 50) throw new Error("完成信号后模型请求未结束"); await Bun.sleep(100);
            }
            paused = true; event("pause_start", { round }); await docker(["pause", runtime.name]);
            try {
              const snapshot = await capturePaused(batch, runtime); finalFiles = snapshot;
              const dir = join(runtime.directory, `round-${round}`); save(join(dir, "files.json"), snapshot);
              const gitStatus = await helper(batch.image, runtime.taskVolume!, ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "status", "--porcelain=v1", "--untracked-files=all"]);
              const head = await helper(batch.image, runtime.taskVolume!, ["git", "rev-parse", "HEAD"]);
              const diff = await helper(batch.image, runtime.taskVolume!, ["git", "-c", "core.fsmonitor=false", "diff", "--binary", "--no-ext-diff", "--no-textconv"]);
              save(join(dir, "git.json"), { head, status: gitStatus, diff });
              event("snapshot", { round, sourceSha256: snapshotHash(snapshot) });
              const evaluated = await grade(batch.image, `${batch.id}-${id}-${round}`, snapshot, round, dir, { status: gitStatus.stdout, head: head.stdout.trim(), expectedHead: commit }, false, extras);
              rounds.push({ round, grade: evaluated }); save(join(runtime.directory, "round-results.json"), rounds);
              console.log(JSON.stringify({ id, round, accepted: evaluated.accepted, visibleFailures: evaluated.visible.filter(x => x.status !== "passed").map(x => x.id), hiddenFailures: evaluated.hidden.filter(x => x.status !== "passed").map(x => x.id) }));
              if (!evaluated.protectionPassed) throw new Error("round_contract_failure: 受保护文件或 Git 基线被改变，轨迹结束");
              let nextPrompt: string | undefined;
              if (round === 1) {
                const feedback = { schemaVersion: 1, trajectoryId: id, roundId: "R1", sourceSha256: evaluated.sourceSha256, visibleSuiteVersion: "c6-real-v1-r1", summary: { passed: evaluated.visible.filter(x => x.status === "passed").length, failed: evaluated.visible.filter(x => x.status === "failed").length, not_run: evaluated.visible.filter(x => x.status === "not_run").length }, checks: evaluated.visible, artifacts: [{ path: "c6/feedback-visible-full.json", sha256: hash(JSON.stringify({ checks: evaluated.visible, commands: Object.fromEntries(Object.entries(evaluated.commands).filter(([k]) => k !== "hidden")) }, null, 2) + "\n") }] };
                extras["c6/feedback-r1.json"] = file(JSON.stringify(feedback, null, 2) + "\n");
                extras["c6/feedback-visible-full.json"] = file(JSON.stringify({ checks: evaluated.visible, commands: Object.fromEntries(Object.entries(evaluated.commands).filter(([k]) => k !== "hidden")) }, null, 2) + "\n");
                extras["c6/round-2.md"] = file(readFileSync(join(ROOT, "evals/specs/c6-real-v1/round-2.md"), "utf8").split("## 反馈包格式")[0]!);
                save(join(dir, "feedback.json"), feedback); await patchPaused(batch, runtime, extras);
                nextPrompt = "开始第二轮。请阅读 c6/round-2.md 和 c6/feedback-r1.json，依据真实可见验收结果修正并验证。完整可见日志在 c6/feedback-visible-full.json。本轮没有新增需求；全通过时复查边界即可，不必人为改代码。保留所有用户文件与 c6/ 下的材料，最后报告实际结果并等待下一轮。";
              } else if (round === 2) {
                const updated = currentSeed(3);
                const patch = Object.fromEntries([POLICY_PATH, "c6/contract-r3.md", "c6/visible.mjs", "c6/types-visible.mts"].map(p => [p, updated[p]!]));
                save(join(dir, "user-patch.json"), { before: snapshot[POLICY_PATH], after: updated[POLICY_PATH], controllerFiles: Object.keys(patch).filter(p => p !== POLICY_PATH) });
                await patchPaused(batch, runtime, patch);
                nextPrompt = "开始第三轮。用户已更新 examples/c6-consumer/policy.ts，保留了原团队规则并新增 token 规则。请阅读该文件和 c6/contract-r3.md，完成 includeOutput、transformText 及示例策略接入；用户 policy.ts 和 notes.md 当前内容不可改动。之前契约继续成立；可见检查改用 node c6/visible.mjs 3，类型命令不变。请实际验证，最后交付。";
              }
              if (round < 3) await control(batch, "next-round", { id, expectedRound: round });
              event("resume", { completedRound: round, nextPrompt });
              return { snapshot, nextPrompt };
            } finally { await docker(["unpause", runtime.name]); paused = false; }
          }
        });
        // 即使后续轮次未完成，也保存其最后修改，不能只留下上轮成功交付快照。
        await docker(["pause", runtime.name], undefined, true);
        try { finalFiles = await capturePaused(batch, runtime); } finally { await docker(["unpause", runtime.name], undefined, true); }
        save(join(runtime.directory, "final-files.json"), finalFiles);
        const summary = { id, task: "C6", repeat, agent, phase, recovery, status: resourceFailure || execution.status, error: execution.error, completedRounds: rounds.length, allRoundsPassed: rounds.length === 3 && rounds.every(x => x.grade.accepted), finalPassed: rounds.find(x => x.round === 3)?.grade.accepted ?? false, wallMs: execution.wallMs, activeMs: execution.activeMs, roundActiveMs: execution.roundActiveMs, budget: execution.proxy.budget, transportIssues: execution.proxy.transportIssues, rounds: rounds.map(x => ({ round: x.round, accepted: x.grade.accepted, visible: x.grade.visible.map(({ id, status }) => ({ id, status })), hidden: x.grade.hidden.map(({ id, status }) => ({ id, status })) })) };
        results.push(summary); save(join(runtime.directory, "result.json"), summary); save(join(batch.directory, "results.json"), results);
      } finally { clearInterval(watchdog); while (watchdogBusy) await Bun.sleep(50); await cleanup(batch, runtime); }
    }
  }
  writeTraceIndex(batch.directory);
} finally {
  save(join(batch.directory, "results.json"), results);
  await docker(["rm", "-f", batch.relay], undefined, true);
}
console.log(JSON.stringify({ phase, batch: batch.id, completed: results.length, allRoundsPassed: results.filter(x => x.allRoundsPassed).length, directory: batch.directory }));
