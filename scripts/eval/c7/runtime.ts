import { join } from "node:path";
import { docker, createRuntime, destroyRuntime, execute, save, type Batch, type Runtime, type Snapshot } from "../core.ts";
import { helper, dependencyMounts } from "../c6/runtime.ts";
import { POLICY_PATH, POLICY_BASE, NOTES_PATH } from "../c6/settings.ts";
import { file } from "./tasks.ts";
import type { TaskId } from "./settings.ts";

export async function newVolume(image: string, name: string, files: Snapshot) {
  await docker(["volume", "create", "--label", "axi.eval.study=c7-20261111", name]);
  await docker(["run", "--rm", "--network", "none", "--entrypoint", "chown", "--mount", `type=volume,src=${name},dst=/task`, image, "1000:1000", "/task"]);
  const restored = await helper(image, name, ["bun", "/opt/eval/c6-files.ts", "restore"], true, JSON.stringify(files));
  if (restored.exitCode) throw new Error(restored.stderr);
}
export async function isolated(image: string, task: TaskId, id: string, files: Snapshot) {
  const name = `axi-c7-${id}`;
  await newVolume(image, name, files);
  try {
    await docker(["run", "-d", "--name", name, "--label", "axi.eval.study=c7-20261111", "--network", "none", "--read-only", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--security-opt", "no-new-privileges", "--cpus", "2", "--memory", "4g", "--pids-limit", "256", "--mount", `type=volume,src=${name},dst=/task`, ...(task === "C7-L" ? dependencyMounts().flatMap(m => ["--mount", m]) : []), "--tmpfs", "/home/eval:rw,nosuid,size=128m", "--tmpfs", "/tmp:rw,nosuid,size=512m", image]);
  } catch (e) { await docker(["volume", "rm", name], undefined, true); throw e; }
  return { name, volume: name, close: async () => { await docker(["rm", "-f", name], undefined, true); await docker(["volume", "rm", name], undefined, true); } };
}
export async function runtime(batch: Batch, task: TaskId, id: string, files: Snapshot, mock?: unknown[]) {
  const volume = `axi-c7-${batch.id}-${id}`;
  const base = { ...files };
  if (task === "C7-L") { base[POLICY_PATH] = file(POLICY_BASE); delete base[NOTES_PATH]; }
  await newVolume(batch.image, volume, base);
  let r: Runtime;
  try { r = await createRuntime(batch, id, { taskVolume: volume, mounts: task === "C7-L" ? dependencyMounts() : [], maxRounds: 1, maxTotal: 50, mock }); }
  catch (e) { await docker(["volume", "rm", volume], undefined, true); throw e; }
  return r;
}
export async function prepareGit(batch: Batch, r: Runtime, task: TaskId, files: Snapshot) {
  await execute(r, ["git", "init", "-q", "-b", "main"]);
  const paths = Object.keys(files).filter(p => task !== "C7-L" || p !== NOTES_PATH);
  await execute(r, ["git", "add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], paths.join("\0") + "\0");
  await execute(r, ["env", "GIT_AUTHOR_NAME=Evaluation", "GIT_COMMITTER_NAME=Evaluation", "GIT_AUTHOR_EMAIL=eval@example.invalid", "GIT_COMMITTER_EMAIL=eval@example.invalid", "GIT_AUTHOR_DATE=2026-11-11T08:00:00Z", "GIT_COMMITTER_DATE=2026-11-11T08:00:00Z", "git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", `冻结 ${task} 修复起点`]);
  if (task === "C7-L") {
    const patched = await helper(batch.image, r.taskVolume!, ["bun", "/opt/eval/c6-files.ts", "patch"], true, JSON.stringify({ [POLICY_PATH]: files[POLICY_PATH], [NOTES_PATH]: files[NOTES_PATH] }));
    if (patched.exitCode) throw new Error(patched.stderr);
  }
  const state = await gitState(r); save(join(r.directory, "initial-git.json"), state); return state;
}
export async function gitState(r: Pick<Runtime, "name">) {
  const head = await execute(r, ["git", "rev-parse", "HEAD"], undefined, true);
  const status = await execute(r, ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "status", "--porcelain=v1", "--untracked-files=all"], undefined, true);
  const diff = await execute(r, ["git", "-c", "core.hooksPath=/dev/null", "diff", "--binary", "--no-ext-diff", "--no-textconv"], undefined, true);
  return { head: head.stdout.trim(), status: status.stdout, diff: diff.stdout, valid: head.exitCode === 0 && status.exitCode === 0 && diff.exitCode === 0 };
}
export async function snapshot(batch: Batch, r: Runtime): Promise<Snapshot> {
  const result = await helper(batch.image, r.taskVolume!, ["bun", "/opt/eval/c6-files.ts", "snapshot"]);
  if (result.exitCode) throw new Error(result.stderr); return JSON.parse(result.stdout);
}
export async function cleanup(batch: Batch, r: Runtime) {
  await docker(["unpause", r.name], undefined, true); await destroyRuntime(batch, r);
  if (r.taskVolume) await docker(["volume", "rm", r.taskVolume], undefined, true);
}
