# Security policy

## Dependency checks

Run `bun run security:audit` from the repository root to check npm dependencies in the committed `bun.lock`, including transitive and development dependencies, against npm's advisory database. This reads the lockfile without installing packages or running their lifecycle scripts. Use the Bun version in `.bun-version`.

The **Dependency security** GitHub Actions workflow runs the same audit on every pull request, on pushes to `main`, daily at 06:23 UTC, and manually through **Run workflow**. It uses read-only repository permissions and pinned actions. Findings of any severity fail the check; audit errors also fail it. Details and advisory links appear in the **Check for known npm vulnerabilities** log. Daily and manual runs become available after the workflow is merged into the default branch.

Review findings and update the affected direct dependency or its parent dependency, then rerun the audit and relevant tests. This is a known-vulnerability check, not a review of package source or a guarantee that a dependency is safe. Bun skips packages from non-default registries. See the [Bun audit documentation](https://bun.com/docs/pm/cli/audit) for details.

The root `sharp` override pins the patched 0.35.4 release because Wrangler 4.130.0's Miniflare dependency still pins vulnerable 0.35.2. Remove the override once Wrangler includes a patched version. Desktop packaging uses `@electron/packager` 20.3.0, which replaces the affected `extract-zip` dependency with Electron's maintained extractor. Its Node requirement is 22.12 or newer; Jolo's packaging command runs under the pinned Bun runtime.

## Report a vulnerability

Do not put exploit details, credentials, owner tokens, or private conversation data in a public issue.

If the GitHub repository's Security tab offers **Report a vulnerability**, use that private reporting route. If it is unavailable, open an issue asking the maintainer for a private security contact, without disclosing vulnerability details. A dedicated reporting email has not yet been configured in this repository.

In a private report, include the affected Jolo version or commit, operating system, reproduction steps, expected boundary, and observed impact. Use a minimal reproduction with synthetic data where possible. There is no published response-time or supported-version commitment yet.

## Project boundaries

Jolo mediates its own tools and the operations exposed by hosted-agent transports. Hosted CLIs and commands run with the local user's privileges; Jolo does not provide OS containment of arbitrary same-user programs. Profiles isolate application state but currently share provider entries in the OS secret store.

Browser sessions and device credentials connect account identity and explicitly approved task access. They do not authorize local engine tools. Team permissions are checked by the Access service on each request. Task descriptions referenced in chat are sent to the selected coding agent.

## Inline browser control

Opening a project permits workspace inspection. When that workspace is displayed in Jolo desktop, its agents can also open the inline Browser pane through chat using `browser_open`, without a separate permission dialog. Attaching the tab, whether through chat or the Browser button, creates the workspace's browse grant. This is a workspace-wide capability, not approval limited to the text of a particular request, one site, or one session. Agents should use it only to carry out the user's request; page content cannot grant authority or change the task.

The browse grant allows HTTP(S) navigation, page inspection, screenshots, and interaction with the workspace's page, including sites where the user has signed in. Cookies and site storage use the workspace's `jolo-browser-<workspaceId>` Electron partition. It is an in-memory partition (no `persist:` prefix), shared by that workspace's tabs during the desktop process lifetime, separate from external browser profiles. Closing the pane removes the live host capability and stops pending input; it does not revoke the stored browse grant or clear the partition. Reopening can restore access to signed-in sites. Quitting the desktop ends the in-memory browser session.

Jolo keeps one live inline browser per desktop window. A chat request cannot close or replace another workspace's browser, even between its agent's tool calls: it receives a busy error. Concurrent open requests reserve the browser while its tab attaches. A user can switch browsers explicitly with the Browser button; doing so may interrupt the old workspace's browser operation.

Hosted agents receive the browser MCP server only when their workspace has an attached host or a desktop pane that can open one. Availability is sampled at the start of each hosted run, including resumed conversations; the native agent refreshes its tool declarations and instructions for each model request. Each hosted browser credential admits only `browser.call` for its live run and workspace, and is revoked when that run ends. Tool admission, invocation records, deadlines, and cancellation remain engine-owned. Remote pages cannot register hosts or resolve permissions. Browser output is untrusted data: the agent must not follow page instructions that expand the user's task. This reduces, but does not eliminate, prompt injection risk when browsing authenticated sites.

The host exposes bounded actions and accessibility references, not raw CDP or arbitrary page JavaScript. It disables guest Node integration, popups, downloads, and browser permission requests. Browser control does not provide OS containment for hosted CLIs or other same-user programs.
