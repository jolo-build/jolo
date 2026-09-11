# Jolo

Jolo is a coding workspace with a terminal CLI and a desktop app. Work with coding agents, review their edits and checks, and continue the same conversations across clients. The desktop includes a browser, terminals, Git worktrees, and a work board.

[Website](https://jolo.build) · [CLI guide](apps/cli/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Features

- Use the built-in agent with an OpenAI-compatible API, or connect an installed Claude Code, Codex, Grok, or Gemini CLI.
- Review proposed commands, inspect diffs, and revert individual agent edits.
- Give tasks separate Git worktrees and track work across projects.
- Switch agents within a conversation or ask another agent for a second opinion.
- Run interactive terminal sessions or headless commands with JSON output.
- Optionally connect a Jolo account for web tasks, teams, labels, and task references in chat.

Jolo is in early development. macOS Apple Silicon is the current release target. Desktop signing, notarization, Linux desktop validation, and automatic updates are not complete.

## Installation

For a desktop release, download the macOS `.dmg` from [GitHub Releases](https://github.com/jolo-build/jolo/releases), open it, and drag **Jolo** to **Applications**. Apple Silicon and Intel Macs have separate installers. Desktop DMGs are built by the release workflow; the first public desktop release has not been published yet.

Install the **CLI only** with:

```sh
curl -fsSL https://jolo.build/install.sh | bash
```

The script installs the CLI and its runtime under `~/.local`; it does not install the desktop app. The original `0.1.0` release supports macOS Apple Silicon. New version-tag releases build CLI packages for macOS and Linux on ARM64 and x64.

## Run from source

Install the Bun version in [.bun-version](.bun-version), then:

```sh
git clone https://github.com/jolo-build/jolo.git
cd jolo
bun install --frozen-lockfile
bun run jolo
# Or start the desktop:
bun run desktop
```

In Jolo, use `/model` to choose an installed coding agent or configure an API provider. Hosted agents must already be installed and authenticated separately. The demo provider is available only in development mode; release builds require a configured model provider or an installed coding agent.

In the desktop board and sidebar, each folder is a workspace and each task is a chat. Expand a workspace to list its tasks, click a task to open its conversation, or choose **New task** in that workspace. The board uses the full window; the workspace sidebar returns when you open a chat. Archived tasks stay grouped by folder in the sidebar’s **Archive** tab.

Separate chats run concurrently, including chats using the same folder, agent, or model. Follow-up messages queue within their own chat; **Send now** interrupts only that chat’s current turn. Tasks in the same folder share its files, and separate Git worktrees remain available when you want isolated changes.

Choose **New chat** to start a conversation without selecting a folder. These chats appear under **Recents**, below your workspace folders, and support the same model and agent choices, saved history, archive, and split views. Chats receive a title from their first message. Each chat has private working storage for agents and generated files, separate from your projects.

Drag a task from the sidebar or board onto a chat to open it in a split pane. Move toward the left, right, top, or bottom to preview its placement; dropping in the center opens it on the right. Existing chats and drafts stay in place, and the divider resizes the panes.

Agent replies can display HTML visualizations using the `visualize` reference format. Desktop previews load HTML files up to 1 MB from the chat’s own workspace, including saved conversations, and offer an expanded view. They run in a sandbox without access to Jolo, local files, browser storage, or network APIs; static libraries and fonts may load from the supported visualization CDNs. The CLI shows a readable file reference instead.

Open a project or start a headless run:

```sh
bun run jolo /path/to/project
bun run jolo agent list
bun run jolo run --agent claude "Explain this repository" --path /path/to/project
```

For the direct API provider, configure a model and enter its API key interactively:

```sh
bun run jolo provider list
bun run jolo auth set openai
bun run jolo model list openai
bun run jolo model set openai/<model-id>
```

Models can be selected per task in **Settings → Models**, or overridden for one command with `jolo run --model <preset>/<model>`. OpenAI Responses, chat completions, Anthropic Messages, and Gemini are supported without vendor SDKs. Token limits are discovered where reported, with optional overrides.

See the [CLI guide](apps/cli/README.md) for commands, profiles, installation, and removal. The engine starts automatically and may outlive a client; finish active work before stopping it.

## Accounts and web tasks

The optional [Access service](apps/access/README.md) provides GitHub sign-in, personal and team tasks, labels, and device approval. Local coding features also work without an account.

After signing in with task access, reference a task in chat:

```text
@codex #JOLO-123 investigate and fix this problem, then run the relevant tests
```

Open the correct local project before sending. The selected task's content is supplied to the coding agent, subject to your current account permissions.

## Repository

| Path | Contents |
| --- | --- |
| `apps/engine` | State, execution, permissions, storage, and tool services |
| `apps/cli` | Headless commands and interactive terminal UI |
| `apps/desktop` | Electron desktop and React UI |
| `apps/access` | Account and task service on Cloudflare Workers/D1 |
| `apps/website` | Public product website |
| `packages` | Shared protocol, client, launcher, and Markdown code |
| `migrations` | Local database migrations |
| `tests` | Unit and integration tests with fixture providers |
| `scripts`, `deploy` | Build, installer, release, and deployment tooling |
| `assets/fonts`, `vendor`, `patches` | Licensed fonts, search metadata, and dependency patches |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for isolated development profiles and validation. Report bugs through [GitHub issues](https://github.com/jolo-build/jolo/issues). Use [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

[MIT](LICENSE). Bundled fonts and optional native search components retain their own licenses in `assets/fonts/` and `vendor/tgrep/`.

### Desktop releases

GitHub Actions builds Apple Silicon and Intel DMG installers alongside the four CLI archives. Pull requests and main-branch builds upload the installers as workflow artifacts. Pushing a version tag matching the root package version (for example `v0.1.1`) verifies all platform checksums and publishes a complete GitHub Release. The download buttons on jolo.build use that release automatically. Desktop installers are currently ad-hoc signed and not notarized.
