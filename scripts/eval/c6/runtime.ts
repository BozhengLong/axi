import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, docker, execute, save, destroyRuntime, type Batch, type Runtime, type Snapshot } from "../core.ts";
import { DEPENDENCY_PATHS, DEPENDENCY_VOLUME, STUDY } from "./settings.ts";

export const dependencyMounts = () => DEPENDENCY_PATHS.map(path => `type=volume,src=${DEPENDENCY_VOLUME},dst=/task/${path},volume-subpath=${path},readonly`);

export async function prepareDependencies(image: string) {
  mkdirSync(STUDY, { recursive: true, mode: 0o700 });
  const exists = await docker(["volume", "inspect", DEPENDENCY_VOLUME], undefined, true);
  if (exists.exitCode === 0) return;
  await docker(["volume", "create", "--label", "axi.eval.study=c6-20261111", DEPENDENCY_VOLUME]);
  const script = DEPENDENCY_PATHS.map(path => `mkdir -p '/deps/${path}'; cp -a '/opt/c6/upstream/${path}/.' '/deps/${path}/'`).join(" && ");
  const result = await docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", "--mount", `type=volume,src=${DEPENDENCY_VOLUME},dst=/deps`, image, "-c", script], undefined, true, 300000);
  save(join(STUDY, "dependency-prepare.json"), { image, result, volume: DEPENDENCY_VOLUME, paths: DEPENDENCY_PATHS });
  if (result.exitCode !== 0) throw new Error("依赖卷准备失败，保留失败现场；不得复用未完成依赖卷");
}

// 此辅助容器不含模型、网络或隐藏验收。暂停候选时，只读访问工作卷。
export async function helper(image: string, volume: string, args: string[], writable = false, input?: string, dependencies = false) {
  return docker(["run", "--rm", "-i", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--cpus", "1", "--entrypoint", "", "--mount", `type=volume,src=${volume},dst=/task${writable ? "" : ",readonly"}`, ...(dependencies ? dependencyMounts().flatMap(m => ["--mount", m]) : []), "--tmpfs", "/tmp:rw,nosuid,size=64m", image, ...args], input, true, 120000);
}

export async function newVolume(image: string, name: string, files: Snapshot) {
  await docker(["volume", "create", "--label", "axi.eval.study=c6-20261111", name]);
  await docker(["run", "--rm", "--network", "none", "--entrypoint", "chown", "--mount", `type=volume,src=${name},dst=/task`, image, "1000:1000", "/task"]);
  const restored = await helper(image, name, ["bun", "/opt/eval/c6-files.ts", "restore"], true, JSON.stringify(files));
  if (restored.exitCode !== 0) throw new Error(`恢复工作卷失败：${restored.stderr}`);
}

export async function c6Runtime(batch: Batch, id: string, files: Snapshot, mock?: unknown[]) {
  const volume = `axi-c6-${batch.id}-${id}`;
  await newVolume(batch.image, volume, files);
  const runtime = await createRuntime(batch, id, { taskVolume: volume, mounts: dependencyMounts(), maxRounds: 3, maxTotal: 150, mock });
  return runtime;
}

export async function capturePaused(batch: Batch, runtime: Runtime): Promise<Snapshot> {
  if (!runtime.taskVolume) throw new Error("C6 需要工作卷");
  const result = await helper(batch.image, runtime.taskVolume, ["bun", "/opt/eval/c6-files.ts", "snapshot"]);
  if (result.exitCode !== 0) throw new Error(`快照失败：${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function patchPaused(batch: Batch, runtime: Runtime, files: Snapshot) {
  const result = await helper(batch.image, runtime.taskVolume!, ["bun", "/opt/eval/c6-files.ts", "patch"], true, JSON.stringify(files));
  if (result.exitCode !== 0) throw new Error(`轮间材料写入失败：${result.stderr}`);
}

export async function cleanup(batch: Batch, runtime: Runtime) {
  await docker(["unpause", runtime.name], undefined, true);
  await destroyRuntime(batch, runtime);
  if (runtime.taskVolume) await docker(["volume", "rm", runtime.taskVolume]);
}

export async function gitState(runtime: Runtime) {
  const result = await execute(runtime, ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "status", "--porcelain=v1"], undefined, true);
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout;
}
