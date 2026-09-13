# jolo-cli

The [Jolo](https://jolo.build) command line interface — a terminal workspace for coding agents.

```sh
npm install -g jolo-cli
jolo /path/to/project
```

Or run a single task:

```sh
jolo run --agent claude "Explain this repository" --path /path/to/project
```

Use Claude Code, Codex, Devin CLI, Grok CLI, Gemini CLI, or your own API provider — install and sign in to your agent separately. Jolo keeps your chats, files, terminal, and a browser in one workspace; a companion desktop app is at [jolo.build](https://jolo.build).

## How this package works

`npm install` downloads the verified Jolo release archive for your platform (macOS and Linux, ARM64 and x64) from [GitHub Releases](https://github.com/jolo-build/jolo/releases) and unpacks it — the checksum is verified before anything is placed on your PATH. There is no Windows build yet.

## Release automation

The `npm-publish` job in `.github/workflows/cli-release.yml` publishes this package
after all CLI and desktop assets have been published to GitHub Releases. Stable
versions use npm's `latest` tag; prereleases use `next`.

npm trusted publishing authorizes GitHub Actions with OIDC, so `NPM_TOKEN` is not
required. The `jolo-cli` package's trusted publisher must allow direct `npm publish`
from organization `jolo-build`, repository `jolo`, workflow `cli-release.yml`.
The publishing job grants `id-token: write` and runs on a GitHub-hosted runner.

## Links

- [User guide](https://docs.jolo.build)
- [Source and issues](https://github.com/jolo-build/jolo)
- [Changelog](https://jolo.build/changelog/)
