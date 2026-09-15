# Jolo CLI

This archive contains Jolo's CLI, engine, and pinned Bun runtime. A global Bun or Node installation is not required. The CLI currently ships for macOS Apple Silicon; the desktop is a separate application.

## Start

To install the `jolo-cli` package with [Bun](https://bun.com/docs/installation):

```sh
bun add -g --trust jolo-cli
```

`--trust` allows Jolo's postinstall script to download and verify the CLI binary. On macOS, you can install Bun with `curl -fsSL https://bun.sh/install | bash`, then restart your terminal before running the command above.

Run `bin/jolo` from this archive, or `jolo` if installed on your `PATH`:

```sh
jolo --version
jolo --help
jolo /path/to/project
```

Inside the terminal UI, use `/model` to choose an agent or configure a provider. Hosted agents must already be installed and authenticated separately. The demo provider is available only in development mode; release builds require a configured model provider or an installed coding agent.

To inspect installed hosted agents and run a task:

```sh
jolo agent list
jolo run --agent claude "Explain this repository" --path /path/to/project
```

For Jolo's model harness, enter an API key through standard input, discover models, and select a default:

```sh
jolo provider list
jolo auth set openai
jolo model list openai
jolo model set openai/<model-id>
jolo run --model openai/<model-id> "Explain this repository"
```

Token limits are optional: `--context-window` and `--max-output` override discovery and conservative defaults. `--effort` sets reasoning effort. Model IDs may contain slashes, such as `openrouter/vendor/model`. `jolo provider set <preset> --base-url <url>` configures an endpoint without changing the selected model. The legacy `provider set openai --model …` command remains available for one release.

`/model <preset>` configures a provider and can find models. Saving selects it for the current task and sets the profile default; selecting a hosted agent keeps the conversation. API keys go only through the credential RPC.

## Everyday use

While a task is running, Enter queues your prompt. Press Enter again within half a second to interrupt and send it now. To send a message that is already waiting, leave the prompt empty and press Enter twice; this sends the first queued message.

Enter sends a prompt, Esc stops the active task, Tab reveals tool output, and `/sessions` opens saved conversations. `/model` changes the answerer. Type `/` to browse commands, keep typing to filter, use ↑/↓ to select, Enter to open, or Tab to complete. Esc dismisses suggestions. The footer shows only the current model. `jolo --help` lists headless commands for sessions, worktrees, plans, approvals, and engine control. From a source checkout, `bun run jolo` and `bun run cli` both launch the client.

Headless exit codes are 0 for success, 1 for failure, 2 for usage errors, 3 for permission pauses, 4 for budget pauses, 5 for other pauses, and 130 for cancellation. Use `--json` on supported commands for structured output.

The engine starts automatically and can outlive a client. Finish work before `jolo engine stop`. Use `--home <dir>` and `--profile <name>` for separate state. Browser tools need a connected desktop host. Hosted programs retain your local user's privileges; Jolo mediates the operations exposed through its tools and adapters.

## Themes

Enter `/themes` to open the theme picker. Use ↑/↓ to select, Enter to apply and save, or Esc to close. `/theme` also opens the picker.

Built-ins include all four [Catppuccin palettes](https://catppuccin.com/palette/) (`catppuccin-latte`, `catppuccin-frappe`, `catppuccin-macchiato`, `catppuccin-mocha`) and [GitHub](https://github.com/primer/github-vscode-theme) Light, Dark, and Dark Dimmed (`github-light`, `github-dark`, `github-dark-dimmed`). `terminal` is the default and uses your terminal's colors.

```sh
jolo theme list
jolo theme use catppuccin-mocha
jolo --theme github-light                 # override for this launch
jolo theme create ocean --from github-dark --set accent=#89b4fa --use
jolo theme install ./ocean.json --use
jolo theme install https://example.com/ocean.json --use
jolo theme show ocean
jolo theme remove ocean
```

Management commands work inside the UI too: `/theme use github-dark`, `/theme create ocean --from catppuccin-mocha`, `/theme install "path with spaces/theme.json" --use`, and `/theme remove ocean`. Repeat `--set color=#RRGGBB` to customize several colors when creating a theme. Creation prints the installed JSON path for further editing. Installation accepts local files, HTTPS JSON URLs, and GitHub `blob` file links. Existing custom themes require `--force` to replace; built-ins cannot be overwritten or removed. All headless theme commands support `--json` and work without an engine.

Custom themes use this JSON format (version 1):

```json
{
  "version": 1,
  "id": "ocean",
  "name": "Ocean",
  "extends": "github-dark",
  "colors": {
    "accent": "#89b4fa",
    "background": "#0d1117",
    "surface": "#161b22"
  }
}
```

`extends` names any built-in color theme and defaults to `catppuccin-mocha`; omitted colors inherit from it. Available color keys are `background`, `surface`, `text`, `muted`, `border`, `accent`, `success`, `warning`, `error`, `keyword`, `string`, `function`, `number`, and `variable`. Colors must be six-digit hex values. The ID must match the filename and contain 1–48 lowercase letters, digits, or hyphens, starting with a letter or digit. Themes are data-only JSON up to 64 KiB; other terminal/editor theme formats need conversion to this format.

Themes and the saved selection live in the profile's `themes/` directory (`<home>/data/<profile>/themes` with `--home`). `jolo theme list --json` reports its location. Custom file edits and external selection changes reload within a second; the picker also discovers newly installed files while open. Invalid edits retain the last working palette and show an error until corrected. The welcome panel repaints with the selected theme. On terminals supporting OSC 10/11, the theme also covers the whole terminal canvas; Jolo restores the original terminal colors on exit. Transcript backgrounds and ordinary text inherit those terminal colors, so existing messages follow theme changes without leaving painted blocks. Previously printed syntax and accent colors remain in native scrollback. Removing the selected custom theme restores `terminal`.

Startup precedence is `--theme`, then `JOLO_THEME`, then the profile's saved selection. A startup override stays in effect until you select a theme in the UI. Explicit invalid overrides report an error; a broken saved theme falls back to terminal colors with an error so it can be repaired. `NO_COLOR` follows the terminal renderer's usual color handling.

## Updates and removal

Run `jolo update` to install the newest published release:

```sh
jolo update --check        # report what is available, install nothing
jolo update                # install it
jolo update 0.2.0-rc.1     # install a named release, including a prerelease
```

Updates come from the project's [GitHub releases](https://github.com/jolo-build/jolo/releases). `jolo update` runs the installer that shipped inside your current release, so it verifies the download's SHA-256 and switches the launcher only after the new build starts successfully; a failed update leaves your installation untouched. Add `--json` for a machine-readable result.

The interactive client mentions a new release on its welcome panel. Nothing installs on its own, and the background check runs at most once a day.

A running engine keeps serving the build it started with, which is why previous installations remain under `PREFIX/share/jolo/releases/` until their processes stop. Finish active tasks, then `jolo engine stop` to move the engine to the new build as well.

The [Jolo website](https://jolo.build) provides the installer for a first install, and rerunning it also upgrades.

To uninstall, stop the engine and remove the managed `PREFIX/bin/jolo` symlink and `PREFIX/share/jolo/` directory. Conversations/settings are stored separately: macOS uses `~/Library/Application Support/jolo/<profile>`; Linux uses `$XDG_DATA_HOME/jolo/<profile>` or `~/.local/share/jolo/<profile>`. A custom home stores them under `<home>/data/<profile>`.

## Local development

Run `bun run jolo` from the repository root to try source changes without rebuilding. Use the Bun version in `.bun-version` and install dependencies with `bun install --frozen-lockfile` first.

To update your installed `jolo` command, quit the CLI and run this from the repository root after each code change:

```sh
(
  set -eu
  bun run build:cli
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/jolo/releases"
  jolo_release_dir=$(mktemp -d "$HOME/.local/share/jolo/releases/local.XXXXXX")
  cp -R dist/cli/. "$jolo_release_dir/"
  "$jolo_release_dir/bin/jolo" --version
  ln -sfn "../share/jolo/releases/${jolo_release_dir##*/}/bin/jolo" "$HOME/.local/bin/jolo"
) && export PATH="$HOME/.local/bin:$PATH" && hash -r && jolo .
```

Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` once to use this installation in new terminals. `command -v jolo` should point to `~/.local/bin/jolo`.

Your saved models, settings, and conversations survive reinstalls. If you changed engine code, finish active tasks and run `jolo engine stop` before reopening the CLI.
