# C6/R1：新增公开 JSONL 输出

> 控制器侧设计稿。实施时把契约、保护清单、准确命令与当前初态文件一起投递；运行前不允许保留未生成的占位文件。

你在 `/task` 接手 Listr2 的冻结副本。请先阅读项目说明、`c6/contract-r1.md`、`c6/environment.md`、`c6/protected-files.json` 和 `c6/initial-changes.md`。

现有 TestRenderer 用于测试。本次需要新增可从公开包入口使用的 `JsonlRenderer` 和 `jsonl` 别名，满足当前契约，保持现有接口与行为兼容。请完成实现、类型、文档、测试及 `examples/c6-consumer/run.ts` 示例。

工作目录已有明确列出的用户修改。`examples/c6-consumer/policy.ts` 和 `notes.md` 受保护，不得覆盖、删除或提交这些修改；可以修改 `run.ts`。不得重置整个仓库或删除旧测试来换取通过。不要创建提交。

依赖已预装。不能联网、安装依赖或修改验证配置。按环境说明实际执行构建、类型检查、相关原测试和可见验收。最后用中文说明修改内容、实际执行及结果、未解决问题。完成后交付本轮，不自行退出会话。
