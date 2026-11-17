# C2试用与发布说明草案

2026-11-17。**尚未发布。** 本轮结果为[INCOMPLETE](../verification/2026-11-17-p02-r2-release-results.md)：工程、安装和新C7通过，代表性任务对照被上游限流中断。下文是固定候选的试用入口，不是发布公告。

## 固定候选试用

候选提交为`dbe7e145d205c21b580d8c2ee2dcf58c408380d8`，分支`codex/v1-beta1-candidate-r2`。需要Git和Bun1.3.14。在新的空目录中准备副本，避免切换正在使用的仓库：

```sh
git clone --branch codex/v1-beta1-candidate-r2 https://github.com/BozhengLong/axi.git axi-c2
cd axi-c2
git checkout --detach dbe7e145d205c21b580d8c2ee2dcf58c408380d8
bun install --frozen-lockfile
```

按候选README配置`ANTHROPIC_BASE_URL`与`ANTHROPIC_API_KEY`。在打算操作的项目目录启动候选的绝对入口：

```sh
bun run /你的绝对路径/axi-c2/src/main.ts
```

先用一个可丢弃的小项目试用。输入一行任务；需要长题面时，把要求保存到文件，再输入“请完整读取任务文件并执行”。当前终端不支持多行粘贴。`/help`查看命令，`/permissions strict`使每个文件操作逐次确认，修改/bash仍需当前调用的`y`。

日常Trace默认记录到被操作项目的`.axi/logs/`，启动时显示绝对路径，退出后保留。记录可能包含文件内容和输出；认证头不记录。日常日志与评测完整证据包的差异见[Trace指南](daily-trace.md)。

## 发布说明草案

C2在原v1文件工具、权限、中断与收尾复核基础上修复P-02读取授权身份绑定：read/glob/grep把根、父路径链及明确目标绑定到同一次提案，授权等待和异步执行期间身份失效则拒绝旧调用。同一对象的正常内容更新与目录增项仍可执行。

已验证macOS/Linux的39项工程、干净安装和新C7两题。本批20题没有完整三方组，不能声明18/20通过或优于Claude Code。当前没有发布版本号、安装分发包或Release。

已有边界保持：默认40工作＋10复核请求，重试计入预算；没有操作系统沙箱、退出后会话恢复或长任务持续执行承诺。上游配额不足仍可能导致任务未完成。具体规则以固定C2的README及其使用文档为准。

本说明保存在评测设施分支；未修改已冻结C2中的README或发布文档。正式合并、tag和Release需要对具体候选另行批准。
