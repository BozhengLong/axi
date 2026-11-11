import { join } from "node:path";
import { command, execute, save, type Batch, type Runtime } from "../core.ts";
import { file, seedFiles, upstreamFiles, currentSeed } from "./task.ts";
import { patchPaused } from "./runtime.ts";
import { STUDY, UPSTREAM_COMMIT, UPSTREAM_TREE, POLICY_PATH, NOTES_PATH } from "./settings.ts";

export async function prepareWorkspace(batch: Batch, runtime: Runtime) {
  await execute(runtime, ["git", "init", "-q", "-b", "main"]);
  await execute(runtime, ["git", "add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], Object.keys(upstreamFiles()).join("\0") + "\0");
  // Git archive 已还原三个 LFS 动图。先恢复索引中的原始指针以核对上游 tree；
  // 随后的夹具提交会固定已还原的二进制，不依赖候选联网下载 LFS。
  const hydrated: string[] = [];
  const upstream = (await command(["git", "-C", join(STUDY, "upstream"), "ls-tree", "-r", UPSTREAM_COMMIT])).stdout.trim().split("\n");
  const staged = (await execute(runtime, ["git", "ls-files", "--stage"])).stdout.trim().split("\n");
  const stagedHashes = new Map(staged.map(line => { const [meta, path] = line.split("\t"); return [path, meta!.split(" ")[1]]; }));
  for (const line of upstream) {
    const [meta, path] = line.split("\t"), [mode, , sha] = meta!.split(" ");
    if (stagedHashes.get(path) === sha) continue;
    const pointer = (await command(["git", "-C", join(STUDY, "upstream"), "cat-file", "blob", sha!])).stdout;
    if (!pointer.startsWith("version https://git-lfs.github.com/spec/v1\n")) throw new Error(`非 LFS 上游字节不匹配：${path}`);
    const written = (await execute(runtime, ["git", "hash-object", "-w", "--stdin"], pointer)).stdout.trim();
    if (written !== sha) throw new Error("LFS 指针导入失败");
    await execute(runtime, ["git", "update-index", "--cacheinfo", `${mode},${sha},${path}`]); hydrated.push(path!);
  }
  const tree = (await execute(runtime, ["git", "write-tree"])).stdout.trim();
  if (tree !== UPSTREAM_TREE) throw new Error(`上游 tree 不匹配：${tree}`);
  const raw = (await command(["git", "-C", join(STUDY, "upstream"), "cat-file", "commit", UPSTREAM_COMMIT])).stdout;
  const imported = (await execute(runtime, ["git", "hash-object", "-t", "commit", "-w", "--stdin"], raw)).stdout.trim();
  if (imported !== UPSTREAM_COMMIT) throw new Error("原始 commit 导入失败");
  // 只提供这个上游提交，明确标记浅历史；不暴露宿主 Git 配置。
  await patchPaused(batch, runtime, { ".git/shallow": file(UPSTREAM_COMMIT + "\n") });
  await execute(runtime, ["git", "update-ref", "refs/heads/main", UPSTREAM_COMMIT]);
  await execute(runtime, ["git", "add", "--all"]);
  await execute(runtime, ["env", "GIT_AUTHOR_NAME=Evaluation", "GIT_COMMITTER_NAME=Evaluation", "GIT_AUTHOR_EMAIL=eval@example.invalid", "GIT_COMMITTER_EMAIL=eval@example.invalid", "GIT_AUTHOR_DATE=2026-11-11T00:00:00Z", "GIT_COMMITTER_DATE=2026-11-11T00:00:00Z", "git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "冻结 C6 公开任务起点"]);
  const commit = (await execute(runtime, ["git", "rev-parse", "HEAD"])).stdout.trim();
  const current = currentSeed();
  await patchPaused(batch, runtime, { [POLICY_PATH]: current[POLICY_PATH]!, [NOTES_PATH]: current[NOTES_PATH]! });
  const status = (await execute(runtime, ["git", "status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  const diff = (await execute(runtime, ["git", "diff", "--binary", "--no-ext-diff", "--no-textconv"])).stdout;
  save(join(runtime.directory, "initial-git.json"), { upstream: UPSTREAM_COMMIT, tree, commit, status, diff, hydratedLfsFiles: hydrated, fixtureFiles: Object.keys(seedFiles()).length });
  return commit;
}
