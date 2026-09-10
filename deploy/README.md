# Deployment configuration

This directory contains configuration and source files for the Jolo website, account service, and CLI distribution. Run commands from the repository root.

| File | Purpose |
| --- | --- |
| [website.wrangler.jsonc](website.wrangler.jsonc) | Worker name, custom domain, static asset binding, and entrypoint |
| [access.wrangler.jsonc](access.wrangler.jsonc) | Separate account Worker, `access.jolo.build`, D1, rate limiting, and session cleanup |
| [website-worker.js](website-worker.js) | Static-asset fallback and streaming of split CLI archives |
| [cli-releases.json](cli-releases.json) | Release origin, latest version, platform archives, sizes, and checksums |

The configured site is [jolo.build](https://jolo.build). The website is built from `apps/website`; generated output and release caches are ignored by Git. Ordinary requests use static assets. Archives above the configured part size are streamed through the Worker at the same installer URL.

## Build and publish

From the repository root, `bun run build` produces the CLI archive and desktop application files. `bun run release:stage dist` verifies and stages a new CLI release in the ignored `.releases/` cache and updates the release catalog. Existing versions are immutable; change the package version before publishing different bytes. `bun run release:restore` downloads cataloged archives and verifies their checksums for a fresh checkout.

Run `bun run website:build` and `bun run website:deploy:check` before `bun run website:deploy`. Set your own domain and Cloudflare resources in the Wrangler configuration when deploying a fork. See [apps/website](../apps/website/README.md) for local website work.

The [account service](../apps/access/README.md) requires a production D1 database and GitHub OAuth credentials. The checked-in production database ID is a placeholder. Local secrets, release caches, and D1 state are ignored by Git.
