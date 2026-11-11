import {execute,save,type Runtime} from "../core.ts";
import {join} from "node:path";
// 只初始化隔离夹具的 Git 起点。固定身份与日期，使双方取得相同提交。
export async function prepareWorkspace(runtime:Runtime){
 await execute(runtime,["git","init","-q"]);
 await execute(runtime,["git","add","--all"]);
 await execute(runtime,["env","GIT_AUTHOR_NAME=Evaluation","GIT_COMMITTER_NAME=Evaluation","GIT_AUTHOR_EMAIL=eval@example.invalid","GIT_COMMITTER_EMAIL=eval@example.invalid","GIT_AUTHOR_DATE=2026-01-01T00:00:00Z","GIT_COMMITTER_DATE=2026-01-01T00:00:00Z","git","commit","-qm","冻结评测任务起点"]);
 const commit=(await execute(runtime,["git","rev-parse","HEAD"])).stdout.trim();
 save(join(runtime.directory,"initial-git.json"),{commit,date:"2026-01-01T00:00:00Z",synthetic:true});return commit;
}
