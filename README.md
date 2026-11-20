# Axi

Axi is a terminal coding agent built with Bun. It can read project files, preview edits, and run shell commands with your approval.

## v0.0.1 Developer Preview

[Download the source bundle](https://github.com/BozhengLong/axi/releases/download/v0.0.1/axi-v0.0.1-source.tar.gz) · [SHA-256 checksums](https://github.com/BozhengLong/axi/releases/download/v0.0.1/SHA256SUMS) · [English quickstart](https://github.com/BozhengLong/axi/releases/download/v0.0.1/PREVIEW.md?edition=20261120-en) · [Release notes](https://github.com/BozhengLong/axi/releases/tag/v0.0.1)

Download the bundle and checksums, verify the archive, then unpack it and run `bun install --frozen-lockfile` with Bun 1.3.14. The quickstart shows how to configure your own Anthropic Messages-compatible gateway and launch Axi in a disposable Git repository.

Tested on macOS ARM64 and in a Linux ARM64 container.

## Run from source

1. Install Git and Bun 1.3.14. From the extracted or cloned Axi directory, run `bun install --frozen-lockfile`.
2. Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` in your terminal. Use a gateway you are authorized to access that serves `claude-opus-5-5`.
3. From a disposable Git repository with an initial commit, run `bun run /absolute/path/to/axi/src/main.ts`. Axi uses the directory you launched it from as its working directory.

Enter `/permissions strict` to confirm each tool call, including reads and searches. Axi shows file diffs and the full text of shell commands before seeking approval. Enter `y` to approve or `n` to decline. The interactive prompts in this preview are in Chinese. Use `/help` to see available commands, `/exit` to quit, or Ctrl+C to stop the current turn.

Approved shell commands run with your account's permissions and can access files outside the working directory. Changes that have already been applied stay in the working tree. Use Git to inspect or revert them. Axi writes session traces to `.axi/logs/` in the working directory. Share only relevant, redacted excerpts when reporting an issue.

## Verify the checkout

Run these commands from a full repository checkout or GitHub's generated source archive.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests
```

The tests use a local mock API and temporary Git repositories. [Report a reproducible issue](https://github.com/BozhengLong/axi/issues) or see the Chinese documentation on [project design](docs/00-vision.md), [file tools and permissions](docs/07-v1-design.md), [retries](docs/guides/task-execution.md), and [session traces](docs/guides/daily-trace.md).
