# Jolo CLI

This archive contains Jolo's CLI, engine, and pinned Bun runtime. A global Bun or Node installation is not required. The CLI currently ships for macOS Apple Silicon; the desktop is a separate application.

## Start

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

Enter sends a prompt, Esc stops the active task, Tab reveals tool output, and `/sessions` opens saved conversations. `/model` changes the answerer. `jolo --help` lists headless commands for sessions, worktrees, plans, approvals, and engine control.

Headless exit codes are 0 for success, 1 for failure, 2 for usage errors, 3 for permission pauses, 4 for budget pauses, 5 for other pauses, and 130 for cancellation. Use `--json` on supported commands for structured output.

The engine starts automatically and can outlive a client. Finish work before `jolo engine stop`. Use `--home <dir>` and `--profile <name>` for separate state. Browser tools need a connected desktop host. Hosted programs retain your local user's privileges; Jolo mediates the operations exposed through its tools and adapters.

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
