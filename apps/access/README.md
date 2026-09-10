# Jolo Access

Account sign-in service for `access.jolo.build`. A separate Cloudflare Worker serves the sign-in, account, and device approval pages, authenticates with GitHub, and stores accounts, browser sessions, device credentials, tasks, teams, invitations, labels, and audit records in D1. The desktop and CLI share browser-approved account connections through their engine and still work while signed out.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run access:db:local
bun run access
```

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
| `scripts/` | Licensed font assets and deployment configuration check |

## Tasks and teams

Open **Tasks** to create personal tasks or tasks in a team workspace. Tasks open in a read-only detail view; **Edit task** opens the editor, and Save or Cancel returns to the view. Tasks have permanent IDs, descriptions, states, priorities, assignees, and labels. Archive removes a task from active lists and chat lookups; restore makes it available again.

Team creators are owners. Owners manage admins, members, and viewers; admins manage members and viewers. Members can edit tasks they created or are assigned. Viewers can read tasks. Invitations require the recipient's exact verified email and explicit acceptance on **Teams**. Invitations expire after seven days; no invitation email is sent automatically. Labels do not grant access.

For task references in desktop or CLI chat, connect with `jolo login --tasks` or desktop Settings → Account → Connect tasks. Then use `@codex #JOLO-123 fix this problem` in the correct local project. Explicitly referenced descriptions are sent to the selected agent. Revoking access prevents new lookups but does not remove content already captured in conversation history. The agent does not automatically update the web task's state.

## Deploy your own service

Create a Cloudflare D1 database and put its ID in `deploy/access.wrangler.jsonc`. Configure your own domain and `ACCESS_ORIGIN`, and register a GitHub OAuth application with callback `<ACCESS_ORIGIN>/callback`. Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` with Wrangler secrets; never put their values in tracked configuration. Apply the migrations in this app's `migrations/` directory to the production database, then run `bun run access:deploy` from the repository root.

The checked-in production database ID is a placeholder. `bun run access:build` only performs a deployment dry run.

## Task workflow checks

`bun run access:test` includes the role matrix, cross-account/team access, invitations, stale writes, CSRF, device scope, and transactional audit tests, plus a real workerd/D1 check. `bun test tests/integration/account.test.js` exercises task references through the real CLI, engine, native loop, Codex, Claude, and ACP fixtures. For the desktop picker, run:

```sh
bun run --cwd apps/desktop build
bun apps/desktop/scripts/smoke.js --tasks
```

Apply migration `0003_tasks_teams.sql` with `bun run access:db:local` before running the updated local service. Existing device credentials remain identity-only until task access is approved.
