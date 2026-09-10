# Contributing to Jolo

Bug reports, documentation improvements, and focused code changes are welcome. For a substantial feature or a change across service boundaries, discuss a written design in a GitHub issue or pull request and obtain the maintainer's agreement before implementation.

## Development setup

Use Git and the exact Bun version in [.bun-version](.bun-version). macOS Apple Silicon is the current release target. Desktop work requires a graphical session; Linux desktop support still needs validation. Product code is JavaScript/JSX. Electron runs the desktop main process in Node and its renderer in Chromium; the engine and CLI use Bun.

```sh
bun install --frozen-lockfile
bun run jolo --help
```

Use an isolated profile to keep tests away from your normal conversations and settings:

```sh
export JOLO_HOME="$(mktemp -d /tmp/jolo-dev.XXXXXX)"
export JOLO_CREDENTIALS=session
bun run jolo provider set fake
bun run desktop
```

The fake provider needs no API key. `JOLO_CREDENTIALS=session` keeps credentials entered during development out of the OS secret store. Use `bun run jolo` in the same shell for terminal development. Finish active work before `bun run jolo engine stop`, then unset `JOLO_HOME` and `JOLO_CREDENTIALS`.

Optional native search is installed with `bun run setup:tgrep`; see [vendor/tgrep](vendor/tgrep/README.md). For web development, see [apps/website](apps/website/README.md) and [apps/access](apps/access/README.md).

## Implementation boundaries

The engine owns application state and side effects. Desktop and CLI clients share the protocol, socket client, and launcher packages. The account service has separate storage and does not grant access to local files or tools.

- Update protocol schemas, callers, and wire fixtures together.
- Keep database migrations ordered and compatible with existing data.
- Engine migrations are TypeScript modules in `migrations/`, registered in `migrations/index.ts`. Preserve released SQL strings and migration names exactly; add a new migration for schema changes. The Access service uses its separate D1 SQL migrations.
- Use temporary profiles and fixture providers in tests.
- Keep credentials, private conversations, generated bundles, and local measurements out of commits.
- Review the [Ink patch notes](patches/README.md) before updating terminal dependencies.

## Validation

| Change | Checks |
| --- | --- |
| Product code | `bun run test` |
| Desktop | `bun run desktop:smoke` in a graphical macOS session |
| Terminal input/rendering | `bun test tests/integration/tui-screen.test.js tests/integration/tui.test.js` |
| Build/installer | `bun test tests/integration/packaging.test.js tests/integration/installer.test.js` |
| Website | `bun run website:build`, then inspect `bun run website:preview` |
| Access service | `bun run access:test`, `bun run access:build`, and `bun run access:test:browser` for browser changes |

`bun run test` includes unit, integration, and colocated application tests. Packaging tests use `dist-test/`; smoke checks use temporary profiles and fixture agents. Report relevant skips and platform limits. `bun run benchmark` writes local measurements under the ignored `results/` directory.

## Pull requests

Describe the problem, the resulting behavior, and how you checked it. Include screenshots for visible changes. Note migration or compatibility implications, and update the relevant README with changed commands or workflows. Keep unrelated changes separate. Use [SECURITY.md](SECURITY.md) for vulnerability reports.
