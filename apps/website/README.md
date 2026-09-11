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

The initial page stays behind a loading indicator until Jolo's stylesheet, JetBrains Mono font, eager images, and React hydration are ready. Failed or stalled required assets show a specific retry message without revealing partially styled content. Optional resources, including Cloudflare's injected analytics script, cannot block the page if a browser or the security policy rejects them. Static HTML remains readable when JavaScript is disabled. The build marks its required assets and adds hashes for the exact startup script and critical styles to the production Content Security Policy.

Run `bun run --cwd apps/website test:loading` on a machine that can launch Electron to check delayed and failed fonts, stylesheets, and scripts, retry behavior, stalled downloads, cached visits, mobile layout, and the no-JavaScript fallback against the production build and security policy.

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

The original macOS Apple Silicon release remains in [cli-releases.json](../../deploy/cli-releases.json). New CLI releases are built for macOS and Linux on ARM64 and x64 by GitHub Actions. The public installer is served at `/install.sh` from [scripts/install.sh](../../scripts/install.sh); the Worker discovers the latest complete stable GitHub release and redirects new versioned downloads to its assets. Vite's local preview serves static assets only; use the Worker tests or Wrangler to exercise dynamic release routing.

The visual direction is black-and-white terminal-inspired minimalism. Keep status colors neutral, controls accessible, and examples clearly illustrative. Font licensing notes are in [assets/fonts](../../assets/fonts/README.md).

## Deployment

The site uses Cloudflare Static Assets with a Worker that handles `/releases/*` before static assets, discovers GitHub releases, and streams original large archives from ordered parts. It has no user-account backend, database, or signup form. Cloudflare may inject its analytics beacon; the site's security policy does not allow that optional script. See [deploy](../../deploy/README.md) for GitHub Actions publishing, the Cloudflare secrets needed for automatic website deployment, dry runs, and domain configuration.
