import assert from 'node:assert/strict';
import { join } from 'node:path';
import { docker, save, type Batch, type Runtime, type Snapshot } from '../core.ts';

// 采集使用另一进程，不能在暂停的被测容器内docker exec。
export async function captureTask(batch: Batch, runtime: Runtime, label: string) {
  assert(runtime.taskVolume, '真实仓库任务必须使用独立Linux工作卷');
  assert(/^[a-zA-Z0-9_-]+$/.test(label));
  const initial = JSON.parse((await docker(['inspect', runtime.name, '--format', '{{json .State}}'])).stdout);
  assert(initial.Running, '容器已不存在，不能补造封存');
  if (!initial.Paused) await docker(['pause', runtime.name]);
  let observed: { schema: number; files: Snapshot; git: { head: string; index: string; status: string }; metadata: unknown; totalBytes: number; entries: number };
  try {
    const frozen = JSON.parse((await docker(['inspect', runtime.name, '--format', '{{json .State}}'])).stdout);
    assert(frozen.Paused, '写入者未全部暂停');
    const args = ['run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,size=64m', '--mount', `type=volume,src=${runtime.taskVolume},dst=/task,readonly`, '--mount', `type=bind,src=${join(import.meta.dir, 'capture.mjs')},dst=/capture.mjs,readonly`, '--entrypoint', 'node', batch.image, '/capture.mjs'];
    save(join(runtime.directory, label + '-capture-command.json'), { args, subjectPaused: true, previouslyPaused: initial.Paused });
    const result = await docker(args, undefined, true, 120000);
    save(join(runtime.directory, label + '-capture-process.json'), { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, stderr: result.stderr });
    assert(result.exitCode === 0 && !result.timedOut, '独立快照采集失败');
    observed = JSON.parse(result.stdout);
    assert(observed.schema === 1 && observed.git.head && observed.git.index && observed.entries > 0);
    save(join(runtime.directory, label + '-snapshot.json'), observed);
  } finally {
    if (!initial.Paused) await docker(['unpause', runtime.name]);
  }
  return observed;
}
