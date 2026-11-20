# 更新 main 以展示 Axi v0.0.1

2026-11-20。用户希望访客打开仓库即可看到已发布的 `v0.0.1` 和英文下载说明。D1–D5 为建议，待确认后执行。

## 现状

GitHub 默认分支 `main` 指向 `cd757052110aaefb993f8bb47e7b92f7e26e4789`。发布标签 `v0.0.1` 指向 `edaaa63738400012d11338db432dd16ce1278c11`。当前 `main` 是发布提交的祖先，前移到该发布版本可保留原历史。匿名访问已核对英文发布说明和英文指南。[公开预发布](https://github.com/BozhengLong/axi/releases/tag/v0.0.1)

开发分支在检查时为 `df84548`。它和发布标签已经分叉，`src/` 中有 14 个文件的内容或路径不同。发布版本的测试也会引用部分 `scripts/eval/` 模块。对齐首页和可运行源码时，采用已经公开下载的完整标签树，可直接复用已验证的源码、依赖锁和测试入口。[发布验证记录](verification/2026-11-20-preview-v001-and-v28-scoring.md)

| 决策 | 建议 |
|---|---|
| D1 主分支基线 | 以固定提交 `edaaa63` 的完整发布树作为 `main` 基线。增加一个只修改根 `README.md` 的提交。 |
| D2 英文首页 | 首页前几行显示项目简介、`v0.0.1 Developer Preview`、源码下载、SHA-256 和英文入门指南。简述 Bun 与模型网关要求。 |
| D3 开发分支 | 保留 U02/U04 新评分、正式冻结的引用校验、安装器方案及后续开发记录。原始运行证据继续在本机私有目录保存。 |
| D4 更新方式 | 在本地隔离工作树准备和验证候选。通过后，用普通快进推送更新 `main`。GitHub 继续使用已有的两条公开分支。 |
| D5 验收与回退 | 比对提交和文件，实测匿名链接和源码入口，复核远端标签。需要回退时，以新提交恢复目标文件或原树。 |

## D1、D3 纳入与保留范围

- `main` 采用 `v0.0.1` 标签的完整源码、依赖、测试和配套文件。标签中已有的历史评测文档和脚本也会随基线进入 `main`，包括现有测试引用的脚本。相对该标签的唯一文件差异是根目录英文 `README.md`。访客浏览首页和克隆 `main` 时，看到的是同一预览版本。
- `codex/v1-preview-scoring` 保留标签后的评分设施、R7 离线复验、候选引用修复、归档记录和 `v0.0.2` 安装器工作。方案 29 的实现仍按其决策单独确认。正式 v1 继续按既有契约验收。[安装器方案](29-official-installer-preview-plan.md) · [正式发布契约](15-v1-release-contract-v2.md#7-发布交付与效力)

## D2 英文首页拟稿

以下内容拟放在 `README.md` 前部。

> # Axi
>
> Axi is a terminal coding agent built with Bun. It can read project files, preview edits, and run shell commands with your approval.
>
> ## v0.0.1 Developer Preview
>
> [Download the source bundle](https://github.com/BozhengLong/axi/releases/download/v0.0.1/axi-v0.0.1-source.tar.gz) · [SHA-256 checksums](https://github.com/BozhengLong/axi/releases/download/v0.0.1/SHA256SUMS) · [English quickstart](https://github.com/BozhengLong/axi/releases/download/v0.0.1/PREVIEW.md?edition=20261120-en) · [Release notes](https://github.com/BozhengLong/axi/releases/tag/v0.0.1)
>
> Download the bundle and checksums, verify the archive, then unpack it and run `bun install --frozen-lockfile` with Bun 1.3.14. The quickstart shows how to configure your own Anthropic Messages-compatible gateway and launch Axi in a disposable Git repository.
>
> Tested on macOS ARM64 and in a Linux ARM64 container.

## D4–D5 执行和验收

1. 重新查询远端 `main` 与 `v0.0.1`。引用与登记身份一致时，从固定发布提交创建本地隔离工作树。增加英文首页提交。
2. 核对从当前 `main` 到候选可快进，且从发布标签到候选只改变 `README.md`。用固定依赖运行 `bun install --frozen-lockfile`、`bun run typecheck`、`bun test tests` 和帮助入口。核对英文、平台说明及 GitHub 下载入口。匿名下载校验源码包及英文指南。
3. 推送候选到 `main`。检查 GitHub 默认首页渲染、可见的版本和链接。复核远端 `main` 为通过检查的提交，`v0.0.1` 标签、预发布状态和附件校验值与更新前的记录一致。若推送因远端提交变动被拒绝，先核对新提交。
4. 若首页内容需要调整，用新提交修正 README。若需要恢复更新前的分支内容，在 `main` 用新提交恢复登记的原树并复验链接与源码。

本次只提交方案。D1–D5 确认后才创建 `main` 更新候选并执行。
