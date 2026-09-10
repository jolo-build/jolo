# Jolo website

The public product website is [jolo.build](https://jolo.build). It is a React/Vite app, separate from the desktop, CLI, and engine. Licensed fonts come from `assets/fonts/`. Example workspaces are illustrative components, not screenshots of user projects.

## Local development

From the repository root, use the Bun version in [.bun-version](../../.bun-version):

```sh
bun install --frozen-lockfile
bun run release:restore
bun run website
```

Open `http://127.0.0.1:5173`. Both development and production builds prepare release assets first, so a fresh checkout needs the catalog's verified archives in the ignored root `.releases/` cache. Restore downloads and checksum-verifies them. Missing or altered archives stop asset preparation.

## Build and preview

```sh
bun run website:build
bun run website:preview
```

The preview is at `http://127.0.0.1:4173`. Both servers bind to localhost. The build produces `dist/` and prerenders the page before client hydration. Generated assets, archives, and build output are ignored; dependencies use the root lockfile.

## Structure

| Path | Purpose |
| --- | --- |
| `src/App.jsx` | Page content, illustrative product examples, and interactions |
| `src/styles.css` | Layout, responsive styling, and reduced-motion behavior |
| `scripts/assets.js` | Copy canonical assets, installer, and verified releases into `public/` |
| `scripts/prerender.jsx` | Render the React page into built HTML |
| `public/` | Static headers, robots directives, sitemap, and standalone 404 page |
| [../../deploy/](../../deploy/README.md) | Worker configuration, archive-serving code, and release catalog |

## Content and distribution

The site presents the early macOS Apple Silicon CLI release and identifies desktop and Linux downloads as work in progress. Release origin/version come from [cli-releases.json](../../deploy/cli-releases.json). The public installer is served at `/install.sh` from [scripts/install.sh](../../scripts/install.sh).

The visual direction is black-and-white terminal-inspired minimalism. Keep status colors neutral, controls accessible, and examples clearly illustrative. Font licensing notes are in [assets/fonts](../../assets/fonts/README.md).

## Deployment

The site uses Cloudflare Static Assets with a Worker entrypoint that streams large archives from ordered parts. It has no user-account backend, database, analytics, or signup form. See [deploy](../../deploy/README.md) for release preparation, dry runs, publishing, and domain configuration.
