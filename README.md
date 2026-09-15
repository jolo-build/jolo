# Jolo

[![Release](https://img.shields.io/github/v/release/jolo-build/jolo?label=release)](https://github.com/jolo-build/jolo/releases/latest)
[![Typecheck](https://github.com/jolo-build/jolo/actions/workflows/typecheck.yml/badge.svg)](https://github.com/jolo-build/jolo/actions/workflows/typecheck.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop app and CLI for working with coding agents.

Use Claude Code, Codex, Devin CLI, Grok CLI, Gemini CLI, or your own API provider. Keep your chats, files, terminal, and browser in one workspace.

[Download](https://github.com/jolo-build/jolo/releases/latest) · [Website](https://jolo.build) · [User guide](https://docs.jolo.build) · [Report a bug](https://github.com/jolo-build/jolo/issues)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/jolo-desktop-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/screenshots/jolo-desktop-light.png">
  <img alt="Jolo Desktop with the chat area on the left and an example task plan on the right" src="assets/screenshots/jolo-desktop-light.png">
</picture>

## What you can do

- Ask an agent to explain code, build a feature, or fix a bug.
- Review changes and run checks beside your chat.
- Open files, a terminal, and a browser without leaving the app.
- Work on several tasks at once, with split views and separate Git worktrees.
- Create a plan, choose an agent for each step, and run the steps in order.
- Attach files and explore diagrams and interactive visualizations.

## Install

**Desktop:** Download the archive for your platform from [GitHub Releases](https://github.com/jolo-build/jolo/releases/latest):

- **macOS** (`.dmg`, Apple Silicon and Intel): open it and drag Jolo into Applications. With Homebrew: `brew install --cask jolo-build/tap/jolo`.
- **Windows** (`.zip`, x64): unpack it and run `Jolo.exe` inside.
- **Linux** (`.tar.gz`, x64 and ARM64): unpack it and run `./Jolo-linux-*/Jolo`.

Jolo is in early development. The macOS app is not yet notarized, Windows and Linux builds are unsigned, and automatic updates are not available.

**CLI:** Run this in your terminal:

```sh
curl -fsSL https://jolo.build/install.sh | bash
```

Or with Homebrew: `brew install jolo-build/tap/jolo-cli`.

Or install the `jolo-cli` package with Bun:

```sh
bun add -g --trust jolo-cli
jolo --version
jolo .
```

`--trust` allows Jolo's postinstall script to download and verify the CLI binary. If you need Bun on macOS, run `curl -fsSL https://bun.sh/install | bash`, then restart your terminal before installing Jolo. See the [Bun installation guide](https://bun.com/docs/installation).

This installs the CLI, not the desktop app. CLI packages are available for macOS and Linux, on ARM64 and x64.

Want a look first? `jolo demo` plays a scripted session — no agent or account needed:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/demo.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/demo-light.svg">
  <img alt="A scripted Jolo session: the agent explains the project layout, adds a saved-searches filter, and reports passing tests" src="assets/brand/demo-light.svg">
</picture>

## Start a task

1. On your first launch, follow the guide to choose an agent, open a folder, and prepare a first task. You can skip it and reopen it from **Getting started** on the work board.
2. Choose an agent and model below the message box.
3. Describe what you want to do.
4. Review the agent's work and continue the conversation.

The guide opens suggested tasks as editable drafts. Review the message and press Send when you are ready. You can also start a new chat without a project folder.

Install and sign in to your coding agent separately before using it in Jolo. You can also configure an API provider.

For Devin, install the [Devin CLI](https://docs.devin.ai/cli/acp/zed) and sign in with `devin auth login`. Restart Jolo, then choose **Devin CLI** or mention `@devin` in chat. Jolo uses your existing local CLI login and reads the available models from Devin.

Prefer the terminal? Open a project with:

```sh
jolo /path/to/project
```

Or run a single task:

```sh
jolo run --agent claude "Explain this repository" --path /path/to/project
```

See the [CLI guide](apps/cli/README.md) for more commands.

## Web tasks

[Jolo Access](https://access.jolo.build) lets you manage personal and team tasks in your browser. Sign in to connect them to the desktop or CLI, then type `#` in chat to reference a task.

An account is optional. You can use Jolo locally without one.

## Run from source

Install the Bun version in [.bun-version](.bun-version), then:

```sh
git clone https://github.com/jolo-build/jolo.git
cd jolo
bun install --frozen-lockfile
bun run desktop
```

For the CLI, use `bun run jolo`. See [local CLI development](apps/cli/README.md#local-development) to rebuild and install your changes.

## Contribute

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and checks, or [SECURITY.md](SECURITY.md) to report a vulnerability.

## Community

- [GitHub issues](https://github.com/jolo-build/jolo/issues) — questions, ideas, and bug reports.
- [ROADMAP.md](ROADMAP.md) — where the project is heading.
- [CHANGELOG.md](CHANGELOG.md) — what changed in each release.

## License

[MIT](LICENSE). Fonts, [agent icons](assets/brand/agents/LICENSE), and optional components in `vendor/` keep their own licenses.
