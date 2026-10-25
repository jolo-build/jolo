# Jolo Access

Account sign-in service for `access.jolo.build`. A separate Cloudflare Worker serves the sign-in, account, and device approval pages, authenticates with Google or GitHub, and stores accounts, browser sessions, device credentials, tasks, teams, invitations, labels, and audit records in D1. The desktop and CLI share browser-approved account connections through their engine and still work while signed out.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run access:db:local
bun run access
```

Migration source lives in `migrations/*.ts`, registered in `migrations/index.ts`. Access commands generate Wrangler's `.sql` files under the ignored `.generated/migrations/` directory before using them and remove stale generated files. Run `bun run access:db:generate` to generate them separately. Keep released SQL text and migration names unchanged: D1 records each applied migration and runs only pending ones. Fresh databases apply the full chain; existing databases upgrade without a schema reset.

Open <http://127.0.0.1:8788>. Without OAuth credentials, the landing page explains that sign-in is unavailable. Copy [.dev.vars.example](.dev.vars.example) to `deploy/.dev.vars.development` and configure either or both providers. For GitHub, create a development OAuth app with callback `http://127.0.0.1:8788/callback`. For Google, create a **Web application** OAuth client with authorized redirect URI `http://127.0.0.1:8788/callback/google`, and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Configure Google's consent screen and test users while the app is in testing. Restart the server afterward. Keep this file out of Git; do not paste secrets into issues or chat.

Only fully configured providers appear on the sign-in page. Device approval offers the same provider choices and retains the device code through sign-in. Google uses the authorization code flow with PKCE and a nonce; `jose` verifies the ID token signature against Google's cached, rotating public keys, plus issuer, audience, authorized party, expiry and nonce. The account requires a verified email. Only profile and email scopes are requested; provider tokens are discarded after verification. See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).

Accounts are keyed by provider and immutable subject, never merged automatically by email. Use the same provider to return to existing tasks and teams. Login flows are bound to their selected provider.

The header's **Theme** selector offers System, Light, and Dark. System follows the browser's color preference, including when JavaScript is disabled. Explicit choices are saved in this browser and applied before rendering subsequent pages. The small same-origin theme script does not change account data; account and task forms remain server-rendered.

Access uses a neutral palette, compact Inter typography, rounded controls, and quiet scrollbars in both light and dark themes. Avatars, activity indicators, links, focus states, and selections use neutral accents. Code and task references use JetBrains Mono.

Pages preload the bundled Inter font and show their content after initial resources and fonts finish loading. While loading, the background already follows the selected theme. Failed downloads fall back normally, and an eight-second deadline prevents a stalled resource from leaving the page hidden. Without JavaScript, pages remain visible.

## Validate

After configuring a provider, connect a source client with `bun run jolo login --server http://127.0.0.1:8788`, or set that URL under desktop Settings → Account → Account server. GitHub's own Device Flow option can remain disabled.

```sh
bun run access:test
bun run access:build
```

For changes to browser forms, cookies, or response headers, also run `bun run access:test:browser` in a graphical desktop session. It uses the repository's Electron browser with temporary cookies and SQLite to submit the real approve, decline, revoke, sign-out, task, team, and label forms. It also checks viewport fit, visible task and approval actions, long task/device lists, and account, sign-in, device-entry, result, and error layouts at laptop, desktop, and phone sizes. No GitHub account or running local access server is needed.

Tests exercise both OAuth exchanges, signed Google token verification, provider mix-ups, callback replay, account separation, and device approval, polling, expiry, cancellation, and revocation. They execute the actual migrations and repository queries in SQLite, including fresh initialization, upgrades of existing data, independent workspace counters, and unique prefix enforcement. Node-based checks also run both providers inside Wrangler's workerd runtime, with outbound requests handled by local fixtures, including rejected upstream redirects. `bun test tests/integration/account.test.js` additionally connects real CLI and engine processes to the fixture service. The build bundles the Worker and assets with Wrangler's deployment dry run; these checks need no provider account and deploy nothing.

## Registration measurement

The public sign-in page demonstrates writing a task, connecting Jolo, and referencing the task in agent chat. Examples contain fictional data and work without JavaScript. New browser accounts reach a welcome page with a first-task action regardless of whether advertising is configured. Returning sign-ins and device approval retain their existing destinations. Task pages show connection guidance until the account has an unexpired device with `tasks:read` access; revoking or expiring that access brings the guidance back.

Production uses X Pixel `rf82t` and the Lead event `tw-rf82t-rf84j` (Jolo Access — registration completed). `X_PIXEL_ID` and `X_REGISTRATION_EVENT_ID` must both be valid to enable measurement; omit them for local development. Apply migration `0010_registration_events.sql` before deploying this version.

The pixel runs on the public sign-in landing page and a generic `/welcome` page after a new browser account is created. The welcome page links to the first-task form and contains no profile or task data. Returning sign-ins, failed authentication, and device approval flows do not generate registration events. The session stores a random, one-use conversion ID; concurrent requests and refreshes cannot emit another event. Existing provider-based identity rules still apply: using Google and GitHub creates two separate accounts, even with the same email.

X receives its standard browser/page signals and a random conversion ID with `status: completed`; the integration does not supply email, name, phone, account ID, task data, or provider credentials. Private pages and OAuth callbacks do not load the pixel or allow X in their security policy. The optional SDK loads after the page has loaded, and Global Privacy Control or Do Not Track disables it. Browser blocking, leaving the welcome page before delivery, or a network failure can undercount events; the one-use event is not retried. X retains its click attribution in its first-party cookie across OAuth. Use campaign-specific UTM links and compare X's reports with actual account creation and first-task activity.

Verify a new Google and GitHub account, a returning login, a welcome-page refresh, and a blocked pixel. Check the event in X Events Manager before enabling conversion-optimized ads. Local tests use fixture event IDs and mocked delivery, so they do not generate production conversions.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/worker.js` | HTTP routes, sessions, sign-out, scheduled cleanup |
| `src/auth.js`, `src/identity.js`, `src/google-auth.js` | GitHub and Google authorization code flows, PKCE, verified identity |
| `src/devices.js` | Device authorization, scoped identity/task bearer sessions, and browser device management |
| `src/tasks/` | Task/team/label forms, validation, live role checks, conditional D1 writes, and audit records |
| `src/security.js` | Origin validation, tokens, cookies, response headers |
| `src/chats.js`, `src/chat-pages.js` | Synced chat API, project and folder views, shared links |
| `src/prompts.js`, `src/relay.js` | Web prompts: composer and status pages, device relay Durable Object |
| `src/storage.js`, `migrations/` | Accounts, one-time login/device flows, browser sessions, and devices |
| `src/pages.js`, `public/styles.css`, `public/theme.js` | Shared viewport shell, navigation, account/authentication panels, and browser theme preference |
| `scripts/` | Licensed font assets, D1 migration generation, and deployment configuration check |

## Tasks and teams

Task descriptions and comments support Markdown: headings, emphasis, links, lists, checklists, fenced code, and tables. The description editor has **Write** and **Preview** modes; saved tasks show the formatted description. Raw HTML is displayed as text, and unsafe link schemes are rejected.

Open **Tasks** to create personal tasks or tasks in a team workspace. Tasks open in a read-only detail view; **Edit task** opens the editor, and Save or Cancel returns to the view. Each personal account and each team has a unique prefix and an independent ticket sequence: `JOLO-1`, `JOLO-2`, and so on. Team members share their team’s sequence. Choose a prefix when creating a team or leave it blank to derive one from the name. Prefixes use 2–24 letters or digits, start with a letter, and are stored in uppercase. A prefix cannot be claimed by another team or personal account. Personal prefixes are assigned automatically. Prefixes stay fixed when account or team names change. Retries do not consume numbers, and archived numbers are never reused. Tasks have descriptions, states, priorities, assignees, and labels. Archive removes a task from active lists and chat lookups; restore makes it available again.

Task details include a persistent discussion with author names, timestamps, and your own edit/delete actions. The description and comments scroll inside the center panel while the task header, details, and comment composer remain available. On phones, details collapse into an expandable row. History shows the latest 50 comments in chronological order with links to older pages. Duplicate form submissions do not create duplicate comments; rejected edits preserve their draft and show the latest saved text.

Owners, admins, and members can comment on team tasks, including tasks they cannot edit. Viewers can read comments. Personal comments remain private to the task owner. Only a comment's author can edit or delete it while they still have commenting access, and archived tasks have read-only discussions. Comment changes and their audit records commit together with live permission checks.

Team creators are owners. Owners manage admins, members, and viewers; admins manage members and viewers. Members can edit tasks they created or are assigned. Viewers can read tasks. Invitations require the recipient's exact verified email and explicit acceptance on **Teams**. Invitations expire after seven days. When `RESEND_API_KEY` and `MAIL_FROM` are configured, creating an invitation queues a Resend email in the same D1 transaction. The page displays delivery status. Failed transient deliveries retry from the five-minute scheduled handler, with a stable idempotency key and payload; revoked, accepted, expired, or no-longer-authorized invitations are cancelled before dispatch. Labels do not grant access.

For task references in desktop or CLI chat, connect with `jolo login --tasks` or desktop Settings → Account → Connect tasks. Choose a task from the desktop’s `#` picker, type a key such as `@codex #JOLO-123 fix this problem`, or paste its full Access link in the correct local project. The picker inserts the short key. The server resolves the unique prefix to its workspace and checks your current permissions; no team hint is needed. API clients read `/api/tasks/JOLO-123` and can optionally restrict a lookup with `team=personal` or a team ID. Existing scoped `JOLO-n` links continue to resolve within their original workspace; old unscoped web links retain their original row-ID meaning. Old ambiguous short chat IDs should be replaced with the key displayed on the task. Explicitly referenced descriptions are sent to the selected agent. Revoking access prevents new lookups but does not remove content already captured in conversation history. The agent does not automatically update the web task's state.

Migration `0007_workspace_task_numbers.sql` assigns independent task numbers within each personal account or team. Migration `0008_task_prefixes.sql` adds unique workspace prefixes while preserving those numbers, row IDs, comments, and ownership. Existing personal accounts receive `PERSONAL1`, `PERSONAL2`, and so on; existing teams receive `TEAM1`, `TEAM2`, and so on. Newly created workspaces use their chosen or name-derived prefix. During rollout, inserts from an older Worker also receive a unique workspace prefix.

## Deploy your own service

Configure your Cloudflare account and D1 database in `deploy/access.wrangler.jsonc`, plus your domain, `ACCESS_ORIGIN`, and verified Resend `MAIL_FROM` address. Register a GitHub OAuth application with callback `<ACCESS_ORIGIN>/callback` (Jolo uses `https://access.jolo.build/callback`), a Google **Web application** OAuth client with authorized redirect URI `<ACCESS_ORIGIN>/callback/google` (`https://access.jolo.build/callback/google`), or both. Google also needs a configured consent screen and production publishing when ready for users beyond the test list. Sign-in requires each app's Client ID and Client Secret, not a personal access token.

Deployment credentials live in the private R2 bucket/object named in `deploy/access-secrets.json`. Keep r2.dev disabled, attach no custom domains, and do not bind this bucket to a public Worker. Authenticate the deployer with `wrangler login` or a separate `CLOUDFLARE_API_TOKEN` authorized for R2, D1, and Worker deployment; this bootstrap authentication must be available before reading R2.

The Access GitHub Actions workflow runs unit and Worker runtime checks, applies pending D1 migrations, and deploys the Worker and assets when manually dispatched. Enable automated releases only after the repository token has the required production permissions. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in repository secrets; routine releases need D1 and Worker deployment permissions. Wrangler retains the service’s existing OAuth and email secret bindings, and `--keep-vars` retains any additional variables configured in the dashboard. The workflow does not read or synchronize the R2 credential backup. Bootstrap the service or rotate its credentials with the full `bun run access:deploy` command below before relying on routine releases.

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

Apply pending migrations with `bun run access:db:local` before running the updated local service. The command generates SQL under stable D1 migration filenames. Apply the prefix migration and deploy the matching Access service before distributing desktop clients that use prefixed keys. Existing databases retain their data and migration history. Device credentials remain identity-only until task access is approved.

## Chat sync

In desktop **Settings → Account**, turn on **Chat sync** and approve it in Access. Enable it on each device. Conversation text then syncs automatically while Jolo is open, every 15 seconds, and appears under **Chats** in Access. Turning it off stops transfers on that device. Signing out also stops sync.

Sync includes standalone chats and project task conversations. Project and workspace identities and names travel with their conversations; standalone chats stay standalone. On another device, project chats remain grouped under their project. Use **Link local folder** to map each synced workspace to its local checkout, even when paths differ between devices. Linking an already-open local project combines its synced conversations with existing tasks. Reading synced history does not require a checkout; starting agents or terminals does. Absolute paths and folder contents are not uploaded. Older text-only histories gain their associations when the original device next syncs with an updated client. Files, attachments, tool output, native agent session IDs, credentials, and running processes are not transferred. Each conversation supports up to 1 MB of text and 10,000 messages, with up to 1,000 conversations per account. Oversized conversations remain local and show a sync notice.

Account-scoped device tokens require the separately approved `chats:sync` scope. Revision checks prevent stale overwrites; when two devices continue independently, both conversation branches remain available. Offline changes retry automatically. A locally deleted chat stays hidden on that device; deleting local history does not delete the server copy.

Deploy migration `0009_chat_sync.sql` with the Access service before shipping desktop chat sync. Deploy the Access version that accepts version 2 project context before updating desktop clients; older clients continue to read version 1 standalone histories but cannot restore version 2 project histories.

**Chats** groups synced conversations by project. Each project row shows its chat count and folders; opening it lists that project's chats under each folder, with the branch shown for worktrees. Chats started outside a project are listed together. If an account has no project chats, the page shows a single list by date. Search covers all titles, or one project's titles when used on a project page. Migration `0012_chat_projects.sql` adds virtual columns read from each chat's stored project context, so existing chats are grouped without a backfill.

Separate machines that open the same repository create separate projects with the same name. Only a folder linked through **Link local folder** joins an existing project.

## Web prompts

A synced chat can be continued from Access, and a project page can start a new chat in one of its folders. The prompt runs on a device where Jolo is open. Turn on **Web prompts** in desktop **Settings → Account**, or run `jolo login --remote`. This requests the `prompts:run` scope together with chat sync. Approve it in the browser. `jolo remote [on|off|status]` shows or changes the setting from a terminal.

The engine opens an outbound WebSocket to `/api/relay`, so the device needs no inbound port. One Durable Object per account (`AccountRelay`, defined in `src/relay.js`) holds these sockets using the hibernation API. Engines ping every 30 seconds, and a device counts as online for 90 seconds after its last message. When it connects, the engine reports the ids of the synced folders it has a real checkout for, and whether it accepts approvals from the web. It never sends local paths. The relay keeps these in Durable Object storage, because a socket attachment holds at most 16 KiB. Access offers a device only if it is online, still holds `prompts:run`, and has the chat's folder. If the desktop and terminal clients are all closed, the engine exits and the device goes offline. Prompts are not queued for offline devices.

A prompt becomes a normal run in that chat on the device and uses the permissions already granted there. The device's desktop transcript labels it *Sent from the web*. If the run needs approval, Access shows the tool, its summary and the command. By default the request waits for an answer on the device. With **Approve from the web** turned on (desktop **Settings → Account**, or `jolo remote --approvals`), the page also offers **Allow once** and **Deny**. Standing grants can only be made on the device. An approval covers the whole request, so a request the page cannot show in full (a command over 4,000 characters, or a summary the tool already shortened) can only be answered on the device. Access accepts an answer only for the request the run is waiting on, and only from a device with this setting turned on. The engine checks both again before applying the answer. Declining stops that prompt and cancels its paused run, so the chat can sync; the next prompt continues it. Each chat has at most one active web prompt, and an account can send at most 10 prompts per minute. The device rejects prompts for chats that are busy, removed, or in unlinked folders. Cancelling in Access cancels the run on the device. If the device is offline, the prompt ends in Access at once, and the relay stops the run when the device reconnects and reports it; it does the same for any run whose prompt expired. The engine saves the prompts it accepted, so after a restart it still reports how they ended. When the run finishes, the device syncs the chat before reporting the result, so the reply appears when the page refreshes. If the sync does not succeed within about two minutes, the result says so. If another device changed the chat meanwhile, the reply is saved as a copy of the chat, and the prompt links to it. While a prompt runs, the page shows the reply so far. About once a second the device sends the latest text to the relay, which keeps only the most recent copy, at most 16,000 characters, until the prompt ends. `public/prompt-live.js` polls `/prompts/<id>/live` and reloads the page when the status or the request the run waits on changes. Without JavaScript the page refreshes itself. If a device never acknowledges a prompt, it expires after two minutes. If an active prompt gets no update for a day, it also expires. Prompt records are deleted after 30 days. Revoking a device closes its relay connection immediately.

Deploy migration `0013_remote_prompts.sql` and the `v1-account-relay` Durable Object migration (`deploy/access.wrangler.jsonc`) before releasing clients that request `prompts:run`. Release clients only after this Access version is live: older Access versions reject unknown scopes. `node scripts/test-relay-runtime.js` checks the relay in workerd. `tests/integration/remote-prompts.test.js` runs a real engine against this app.
