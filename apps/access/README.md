# Jolo Access

Account sign-in service for `access.jolo.build`. A separate Cloudflare Worker serves the sign-in, account, and device approval pages, authenticates with GitHub, and stores accounts, browser sessions, device credentials, tasks, teams, invitations, labels, and audit records in D1. The desktop and CLI share browser-approved account connections through their engine and still work while signed out.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run access:db:local
bun run access
```

Migration source lives in `migrations/*.ts`, registered in `migrations/index.ts`. Access commands generate Wrangler's `.sql` files under the ignored `.generated/migrations/` directory before using them. Run `bun run access:db:generate` to generate those files separately. Keep released SQL text and migration names unchanged so existing D1 databases retain their migration history.

Open <http://127.0.0.1:8788>. Without OAuth credentials, the landing page explains that sign-in is unavailable. To enable sign-in, create a separate development GitHub OAuth app with callback `http://127.0.0.1:8788/callback`, copy [.dev.vars.example](.dev.vars.example) to `deploy/.dev.vars.development`, and fill in its two values locally. Restart the server afterward. Keep this file out of Git; do not paste secrets into issues or chat.

## Validate

After configuring GitHub, connect a source client with `bun run jolo login --server http://127.0.0.1:8788`, or set that URL under desktop Settings → Account → Account server. GitHub's own Device Flow option can remain disabled.

```sh
bun run access:test
bun run access:build
```

For changes to browser forms, cookies, or response headers, also run `bun run access:test:browser` in a graphical desktop session. It uses the repository's Electron browser with temporary cookies and SQLite to submit the real approve, decline, revoke, sign-out, task, team, and label forms. It also checks viewport fit, visible task and approval actions, long task/device lists, and account, sign-in, device-entry, result, and error layouts at laptop, desktop, and phone sizes. No GitHub account or running local access server is needed.

Tests exercise the OAuth exchange and device approval, polling, expiry, cancellation, and revocation with fixture GitHub responses and execute the actual migrations and repository queries in SQLite. A Node-based check also runs the GitHub exchange inside Wrangler's workerd runtime, with outbound requests handled by local fixtures, including rejected upstream redirects. `bun test tests/integration/account.test.js` additionally connects real CLI and engine processes to the fixture service. The build bundles the Worker and assets with Wrangler's deployment dry run; these checks need no GitHub account and deploy nothing.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/worker.js` | HTTP routes, sessions, sign-out, scheduled cleanup |
| `src/auth.js`, `src/identity.js` | GitHub authorization code flow, PKCE, verified identity |
| `src/devices.js` | Device authorization, scoped identity/task bearer sessions, and browser device management |
| `src/tasks/` | Task/team/label forms, validation, live role checks, conditional D1 writes, and audit records |
| `src/security.js` | Origin validation, tokens, cookies, response headers |
| `src/storage.js`, `migrations/` | Accounts, one-time login/device flows, browser sessions, and devices |
| `src/pages.js`, `public/styles.css` | Shared viewport shell, navigation, and account/authentication panels; no browser JavaScript |
| `scripts/` | Licensed font assets, D1 migration generation, and deployment configuration check |

## Tasks and teams

Open **Tasks** to create personal tasks or tasks in a team workspace. Tasks open in a read-only detail view; **Edit task** opens the editor, and Save or Cancel returns to the view. Tasks have permanent IDs, descriptions, states, priorities, assignees, and labels. Archive removes a task from active lists and chat lookups; restore makes it available again.

Team creators are owners. Owners manage admins, members, and viewers; admins manage members and viewers. Members can edit tasks they created or are assigned. Viewers can read tasks. Invitations require the recipient's exact verified email and explicit acceptance on **Teams**. Invitations expire after seven days. When `RESEND_API_KEY` and `MAIL_FROM` are configured, creating an invitation queues a Resend email in the same D1 transaction. The page displays delivery status. Failed transient deliveries retry from the five-minute scheduled handler, with a stable idempotency key and payload; revoked, accepted, expired, or no-longer-authorized invitations are cancelled before dispatch. Labels do not grant access.

For task references in desktop or CLI chat, connect with `jolo login --tasks` or desktop Settings → Account → Connect tasks. Then use `@codex #JOLO-123 fix this problem` in the correct local project. Explicitly referenced descriptions are sent to the selected agent. Revoking access prevents new lookups but does not remove content already captured in conversation history. The agent does not automatically update the web task's state.

## Deploy your own service

Configure your Cloudflare account and D1 database in `deploy/access.wrangler.jsonc`, plus your domain, `ACCESS_ORIGIN`, and verified Resend `MAIL_FROM` address. Register a GitHub OAuth application with callback `<ACCESS_ORIGIN>/callback` (Jolo uses `https://access.jolo.build/callback`). Sign-in requires the app's Client ID and Client Secret, not a personal access token.

Deployment credentials live in the private R2 bucket/object named in `deploy/access-secrets.json`. Keep r2.dev disabled, attach no custom domains, and do not bind this bucket to a public Worker. Authenticate the deployer with `wrangler login` or a separate `CLOUDFLARE_API_TOKEN` authorized for R2, D1, and Worker deployment; this bootstrap authentication must be available before reading R2.

Store an OAuth file containing `GITHUB_CLIENT_ID=...` and `GITHUB_CLIENT_SECRET=...` (one per line), and a separate file containing the bare Resend key. Import or rotate them with:

```sh
bun run --cwd apps/access secrets:store /tmp/jolo_oauth_key.txt /tmp/jolo_key.txt
bun run access:deploy
```

The import checks bucket privacy, uploads the three credentials, and verifies the stored values without printing them. Deployment reads them from R2, validates them, applies the generated D1 migrations, and publishes them atomically with the Worker as secret bindings. Temporary credential files have mode 0600 and are removed on completion or failure. Credentials never enter tracked configuration or website assets. Updating R2 takes effect on the next deployment.

`bun run access:build` only performs a deployment dry run and needs no production credentials. Invitations remain usable locally without email configuration. Unit and runtime checks mock external services and send no real emails.

## Task workflow checks

`bun run access:test` includes the role matrix, cross-account/team access, invitations, stale writes, CSRF, device scope, and transactional audit tests, plus a real workerd/D1 check. `bun test tests/integration/account.test.js` exercises task references through the real CLI, engine, native loop, Codex, Claude, and ACP fixtures. For the desktop picker, run:

```sh
bun run --cwd apps/desktop build
bun apps/desktop/scripts/smoke.js --tasks
```

Apply migration `0003_tasks_teams.ts` with `bun run access:db:local` before running the updated local service. The command generates `0003_tasks_teams.sql` for D1 under its original name. Existing device credentials remain identity-only until task access is approved.
