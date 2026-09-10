# Deployment configuration

This directory contains configuration and source files for the Jolo website, account service, and CLI distribution. Run commands from the repository root.

| File | Purpose |
| --- | --- |
| [website.wrangler.jsonc](website.wrangler.jsonc) | Worker name, custom domain, static asset binding, and entrypoint |
| [access.wrangler.jsonc](access.wrangler.jsonc) | Separate account Worker, `access.jolo.build`, D1, rate limiting, and session cleanup |
| [website-worker.js](website-worker.js) | Installer routing, static fallback, and streaming of original split CLI archives |
| [github-releases.js](github-releases.js) | Discover complete stable GitHub releases and redirect new platform downloads |
| [cli-releases.json](cli-releases.json) | Original website-hosted releases, retained with their original checksums |

The configured site is [jolo.build](https://jolo.build). The website is built from `apps/website`; generated output and release caches are ignored by Git. Ordinary requests use static assets. Archives above the configured part size are streamed through the Worker at the same installer URL.

## Build and publish

The [CLI release workflow](../.github/workflows/cli-release.yml) builds native packages on macOS ARM64, macOS x64, Linux ARM64, and Linux x64. Pull requests, pushes to `main`, and manual runs produce downloadable Actions artifacts. A `v*` tag push also publishes a GitHub Release after all four jobs pass. Each job checks the installer, builds the CLI with the pinned Bun runtime and tgrep, then installs and runs that exact archive against a local model API fixture. No model credentials or desktop GUI are needed.

To publish, bump the root `package.json` version, merge the changes, then push a matching tag, for example `v0.1.1`. The tag must match the package version. The existing `0.1.0` website release cannot be replaced. Stable versions must advance the current latest version; tags such as `v0.2.0-rc.1` publish as prereleases and do not change the installer's default. The release job uses only GitHub's automatic `GITHUB_TOKEN` with `contents: write`; no personal token is required.

Publishing validates the four archives, checksums, and manifests again, uploads everything to a draft, and only then makes it public. Failed uploads leave a draft that a workflow rerun can finish. Published releases are never overwritten. Download Actions artifacts from a branch/manual run for testing; these runs never publish releases.

The installer remains `curl -fsSL https://jolo.build/install.sh | bash`. The website Worker resolves `/releases/latest.txt` from GitHub's latest complete stable release, with a five-minute cache. Versioned archive and checksum URLs redirect to GitHub Releases when no original static asset exists. Original static downloads remain unchanged. `--version 0.2.0-rc.1` installs a prerelease explicitly. Metadata outages return an error rather than silently choosing an older release.

The [website workflow](../.github/workflows/website-deploy.yml) deploys distribution/site changes from `main`, or on manual dispatch. Configure repository secrets `CLOUDFLARE_API_TOKEN` (a token allowed to deploy the website Worker/static assets and its route) and `CLOUDFLARE_ACCOUNT_ID`. Deploy this routing change once before the first CI release. Future CLI releases become available without another website deployment. Forks must update the fixed GitHub repository in `github-releases.js`, the website workflow repository guard, and the domain configuration.

For local builds, `bun run build:cli` produces the native CLI archive; `bun scripts/smoke-install.js --dist dist` installs and tests it in a temporary directory. `bun run build` also prepares the desktop application. The distributed CLI is a launcher plus bundled JavaScript and a pinned native Bun executable, so users do not need Bun or Node installed. The experimental `--compile` target and desktop signing/notarization are separate from this workflow.

The legacy `bun run release:stage dist` command is retained for website-hosted archives. It verifies and stages an archive in `.releases/` and updates the legacy catalog. `bun run release:restore` downloads cataloged archives and verifies their checksums for a fresh website checkout. New automated releases use GitHub assets instead of growing this cache.

Run `bun run website:build` and `bun run website:deploy:check` before `bun run website:deploy`. Set your own domain and Cloudflare resources in the Wrangler configuration when deploying a fork. See [apps/website](../apps/website/README.md) for local website work.

The [account service](../apps/access/README.md) requires a production D1 database and GitHub OAuth credentials. The checked-in production database ID is a placeholder. Local secrets, release caches, and D1 state are ignored by Git.
