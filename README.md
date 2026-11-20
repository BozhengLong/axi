# Axi

**An AI coding agent for your terminal.**

Explore a codebase, work through a fix, and decide which changes Axi applies.

[Download Axi v0.0.1](https://github.com/BozhengLong/axi/releases/download/v0.0.1/axi-v0.0.1-source.tar.gz) · [Quickstart](https://github.com/BozhengLong/axi/releases/download/v0.0.1/PREVIEW.md?edition=20261120-en) · [Release notes](https://github.com/BozhengLong/axi/releases/tag/v0.0.1)

**Developer preview** · Tested on Apple silicon Macs and in a Linux ARM64 container.

## Work with Axi

- **Explore your project.** Search and read project files as you work through a task in one terminal session.
- **Review proposed changes.** See the diff before a file edit is applied. Shell commands show the full command and working directory and wait for your approval.
- **Inspect the session afterward.** Axi keeps a local record of tool calls, approvals, and results in the project's `.axi/logs/` directory.

## Get started

1. Download the source bundle and [SHA-256 checksums](https://github.com/BozhengLong/axi/releases/download/v0.0.1/SHA256SUMS). Verify the archive and unpack it. Install Git and Bun 1.3.14, then run `bun install --frozen-lockfile` in the Axi directory.
2. Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` using your own Anthropic Messages-compatible gateway. This preview requests `claude-opus-5-5`.
3. Open a disposable Git repository with an initial commit and run `bun run /absolute/path/to/axi/src/main.ts`. Axi uses your current directory as its workspace.

Enter `/permissions strict` to confirm reads and searches as well as edits and commands. The preview displays interactive prompts in Chinese. Use `y` to approve, `n` to decline, and `/help` for the full command list. The [English quickstart](https://github.com/BozhengLong/axi/releases/download/v0.0.1/PREVIEW.md?edition=20261120-en) has the exact verification and launch steps.

Approved shell commands run with your account's operating-system permissions. Applied changes stay in the working tree and can be inspected or reverted with Git.

## Development and support

From a full repository checkout or GitHub's generated source archive, run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests
```

The tests use a local mock API and temporary Git repositories. [Report an issue](https://github.com/BozhengLong/axi/issues) with the version, reproduction steps, and the smallest useful redacted excerpt. The Chinese project documentation covers [the roadmap](docs/00-vision.md), [file tools and permissions](docs/07-v1-design.md), [retries](docs/guides/task-execution.md), and [session traces](docs/guides/daily-trace.md).
