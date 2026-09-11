# Jolo Access

Account sign-in service for `access.jolo.build`. A separate Cloudflare Worker serves the sign-in, account, and device approval pages, authenticates with Google or GitHub, and stores accounts, browser sessions, device credentials, tasks, teams, invitations, labels, and audit records in D1. The desktop and CLI share browser-approved account connections through their engine and still work while signed out.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run access:db:local
bun run access
```

Migration source lives in `migrations/*.ts`, registered in `migrations/index.ts`. Access commands generate Wrangler's `.sql` files under the ignored `.generated/migrations/` directory before using them. Run `bun run access:db:generate` to generate those files separately. Keep released SQL text and migration names unchanged so existing D1 databases retain their migration history.

Open <http://127.0.0.1:8788>. Without OAuth credentials, the landing page explains that sign-in is unavailable. Copy [.dev.vars.example](.dev.vars.example) to `deploy/.dev.vars.development` and configure either or both providers. For GitHub, create a development OAuth app with callback `http://127.0.0.1:8788/callback`. For Google, create a **Web application** OAuth client with authorized redirect URI `http://127.0.0.1:8788/callback/google`, and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Configure Google's consent screen and test users while the app is in testing. Restart the server afterward. Keep this file out of Git; do not paste secrets into issues or chat.

Only fully configured providers appear on the sign-in page. Device approval offers the same provider choices and retains the device code through sign-in. Google uses the authorization code flow with PKCE and a nonce; `jose` verifies the ID token signature against Google's cached, rotating public keys, plus issuer, audience, authorized party, expiry and nonce. The account requires a verified email. Only profile and email scopes are requested; provider tokens are discarded after verification. See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).

Accounts are keyed by provider and immutable subject, never merged automatically by email. Use the same provider to return to existing tasks and teams. Migration `0005_google_auth.sql` preserves existing GitHub account IDs and all related data while adding Google identities and binding login flows to a provider.

The header's **Theme** selector offers System, Light, and Dark. System follows the browser's color preference, including when JavaScript is disabled. Explicit choices are saved in this browser and applied before rendering subsequent pages. The small same-origin theme script does not change account data; account and task forms remain server-rendered.

Access shares the desktop palette, compact Inter typography, rounded controls, blue activity accents, and quiet scrollbars in both light and dark themes. Code and task references use JetBrains Mono.

Pages preload the bundled Inter font and show their content after initial resources and fonts finish loading. While loading, the background already follows the selected theme. Failed downloads fall back normally, and an eight-second deadline prevents a stalled resource from leaving the page hidden. Without JavaScript, pages remain visible.

## Validate

After configuring a provider, connect a source client with `bun run jolo login --server http://127.0.0.1:8788`, or set that URL under desktop Settings → Account → Account server. GitHub's own Device Flow option can remain disabled.

```sh
bun run access:test
bun run access:build
```

For changes to browser forms, cookies, or response headers, also run `bun run access:test:browser` in a graphical desktop session. It uses the repository's Electron browser with temporary cookies and SQLite to submit the real approve, decline, revoke, sign-out, task, team, and label forms. It also checks viewport fit, visible task and approval actions, long task/device lists, and account, sign-in, device-entry, result, and error layouts at laptop, desktop, and phone sizes. No GitHub account or running local access server is needed.

Tests exercise both OAuth exchanges, signed Google token verification, provider mix-ups, callback replay, account separation, and device approval, polling, expiry, cancellation, and revocation. They execute the actual migrations and repository queries in SQLite, including migration of existing account data. Node-based checks also run both providers inside Wrangler's workerd runtime, with outbound requests handled by local fixtures, including rejected upstream redirects. `bun test tests/integration/account.test.js` additionally connects real CLI and engine processes to the fixture service. The build bundles the Worker and assets with Wrangler's deployment dry run; these checks need no provider account and deploy nothing.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/worker.js` | HTTP routes, sessions, sign-out, scheduled cleanup |
| `src/auth.js`, `src/identity.js`, `src/google-auth.js` | GitHub and Google authorization code flows, PKCE, verified identity |
| `src/devices.js` | Device authorization, scoped identity/task bearer sessions, and browser device management |
| `src/tasks/` | Task/team/label forms, validation, live role checks, conditional D1 writes, and audit records |
| `src/security.js` | Origin validation, tokens, cookies, response headers |
| `src/storage.js`, `migrations/` | Accounts, one-time login/device flows, browser sessions, and devices |
| `src/pages.js`, `public/styles.css`, `public/theme.js` | Shared viewport shell, navigation, account/authentication panels, and browser theme preference |
| `scripts/` | Licensed font assets, D1 migration generation, and deployment configuration check |

## Tasks and teams

Open **Tasks** to create personal tasks or tasks in a team workspace. Tasks open in a read-only detail view; **Edit task** opens the editor, and Save or Cancel returns to the view. Tasks have permanent IDs, descriptions, states, priorities, assignees, and labels. Archive removes a task from active lists and chat lookups; restore makes it available again.

Task details include a persistent discussion with author names, timestamps, and your own edit/delete actions. The description and comments scroll inside the center panel while the task header, details, and comment composer remain available. On phones, details collapse into an expandable row. History shows the latest 50 comments in chronological order with links to older pages. Duplicate form submissions do not create duplicate comments; rejected edits preserve their draft and show the latest saved text.

Owners, admins, and members can comment on team tasks, including tasks they cannot edit. Viewers can read comments. Personal comments remain private to the task owner. Only a comment's author can edit or delete it while they still have commenting access, and archived tasks have read-only discussions. Comment changes and their audit records commit together with live permission checks. Migration `0006_task_comments.sql` adds the comment table and history index without changing existing tasks; apply pending migrations before deploying the updated Worker.

Team creators are owners. Owners manage admins, members, and viewers; admins manage members and viewers. Members can edit tasks they created or are assigned. Viewers can read tasks. Invitations require the recipient's exact verified email and explicit acceptance on **Teams**. Invitations expire after seven days. When `RESEND_API_KEY` and `MAIL_FROM` are configured, creating an invitation queues a Resend email in the same D1 transaction. The page displays delivery status. Failed transient deliveries retry from the five-minute scheduled handler, with a stable idempotency key and payload; revoked, accepted, expired, or no-longer-authorized invitations are cancelled before dispatch. Labels do not grant access.

For task references in desktop or CLI chat, connect with `jolo login --tasks` or desktop Settings → Account → Connect tasks. Then use `@codex #JOLO-123 fix this problem` in the correct local project. Explicitly referenced descriptions are sent to the selected agent. Revoking access prevents new lookups but does not remove content already captured in conversation history. The agent does not automatically update the web task's state.

## Deploy your own service

Configure your Cloudflare account and D1 database in `deploy/access.wrangler.jsonc`, plus your domain, `ACCESS_ORIGIN`, and verified Resend `MAIL_FROM` address. Register a GitHub OAuth application with callback `<ACCESS_ORIGIN>/callback` (Jolo uses `https://access.jolo.build/callback`), a Google **Web application** OAuth client with authorized redirect URI `<ACCESS_ORIGIN>/callback/google` (`https://access.jolo.build/callback/google`), or both. Google also needs a configured consent screen and production publishing when ready for users beyond the test list. Sign-in requires each app's Client ID and Client Secret, not a personal access token.

Deployment credentials live in the private R2 bucket/object named in `deploy/access-secrets.json`. Keep r2.dev disabled, attach no custom domains, and do not bind this bucket to a public Worker. Authenticate the deployer with `wrangler login` or a separate `CLOUDFLARE_API_TOKEN` authorized for R2, D1, and Worker deployment; this bootstrap authentication must be available before reading R2.

The Access GitHub Actions workflow runs unit and Worker runtime checks, applies pending D1 migrations, and deploys the Worker and assets on changes merged to `main` or manual dispatch. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in repository secrets; routine releases need D1 and Worker deployment permissions. Wrangler retains the service’s existing OAuth and email secret bindings, and `--keep-vars` retains any additional variables configured in the dashboard. The workflow does not read or synchronize the R2 credential backup. Bootstrap the service or rotate its credentials with the full `bun run access:deploy` command below before relying on routine releases.

Store an OAuth file containing `GITHUB_CLIENT_ID=...` and `GITHUB_CLIENT_SECRET=...`, `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...`, or both pairs (one per line), and a separate file containing the bare Resend key. Include all providers you want enabled: the import replaces the stored credential set. Existing GitHub-only credential files remain valid. Import or rotate them with:

```sh
bun run --cwd apps/access secrets:store /tmp/jolo_oauth_key.txt /tmp/jolo_key.txt
bun run access:deploy
```

The import checks bucket privacy, uploads the configured credentials, and verifies the stored values without printing them. Deployment reads them from R2, validates them, applies the generated D1 migrations, and publishes them atomically with the Worker as secret bindings. Temporary credential files have mode 0600 and are removed on completion or failure. Credentials never enter tracked configuration or website assets. Updating R2 takes effect on the next full `bun run access:deploy`; routine GitHub Actions releases preserve the already configured credentials.

`bun run access:build` only performs a deployment dry run and needs no production credentials. Invitations remain usable locally without email configuration. Unit and runtime checks mock external services and send no real emails.

## Task workflow checks

`bun run access:test` includes the role matrix, cross-account/team access, invitations, stale writes, CSRF, device scope, and transactional audit tests, plus a real workerd/D1 check. `bun test tests/integration/account.test.js` exercises task references through the real CLI, engine, native loop, Codex, Claude, and ACP fixtures. For the desktop picker, run:

```sh
bun run --cwd apps/desktop build
bun apps/desktop/scripts/smoke.js --tasks
```

Apply migration `0003_tasks_teams.ts` with `bun run access:db:local` before running the updated local service. The command generates `0003_tasks_teams.sql` for D1 under its original name. Existing device credentials remain identity-only until task access is approved.
