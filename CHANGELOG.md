# Changelog

All notable changes to Jolo are documented here. This project uses [semantic versioning](https://semver.org/) for tagged releases.

## [Unreleased]

- Claude Code now keeps one process per conversation across turns instead of a process per turn, so background work it starts (subagents, workflows, long commands) is no longer killed when the turn's answer arrives; an answer Claude gives by itself afterwards becomes a run of its own.
- Stopping a Claude turn interrupts it instead of killing the process; the process is closed when the task is archived or deleted, its worktree removed, the model changed, the engine stopped, or after thirty minutes idle (`JOLO_HOSTED_IDLE_MS`).
- Fixed a message sent right after such a lost background task coming back empty: an empty result Claude sends ahead of its answer no longer ends the turn.
- A background subagent that asks permission after Claude's turn ended gets a short run that ends once it is answered, instead of a run that held the conversation until the background work finished; stopping that run denies the request rather than killing the process and every task in it.
- Claude's answer is matched to the message it answers (Claude echoes each message as it takes it up), so an answer Claude gives by itself just before taking up yours no longer replaces yours; an answer that starts after an empty result is no longer cut off.
- Stopping a turn no longer kills the process when Claude sends a tool call after the stop, a refused worktree removal no longer stops the agents working in it, an agent's read-only temporary files no longer crash the engine, and an answer Claude gives by itself while a run is finishing is offered again once the conversation is free.
- Answering one of several background permission requests keeps the run waiting on the others (its time and model-call budgets still count the work going on meanwhile), a request that arrives just as a run is stopped is denied at once instead of being asked, and a request Claude takes back closes its prompt.
- A run kept open only by a background request no longer ends partway through a turn Claude began meanwhile, spends no active-time budget while it only waits on the user, and with no window open waits for one instead of pausing. A paused run closes the other requests it was asking, so it can be resumed, and a run Claude began by itself carries on after a pause instead of ending empty. Stopping right after Claude's empty result interrupts the turn without swallowing or killing work Claude starts next, a turn Claude begins after a run that was only an empty result gets a run of its own, and compaction or API retries after an empty result no longer cut the answer off.
- The terminal interface shows every open permission request in turn instead of only the latest, so one asked while another is open is no longer lost, and a request whose run ended while the chat was opening no longer blocks the prompt.
- What another agent said in a Claude conversation is no longer lost to Claude when Claude carries on by itself before its next turn: the next turn still delivers it.
- A hosted agent that prints thousands of lines at once (a long streamed answer arriving after a busy moment) no longer has its process killed for output overflow; only a reader that stops reading for a second or more still is.
- A background agent's question is told apart from the main thread's even when the agent was started in an earlier turn, Claude's report of finished background work is no longer cut off by a stop or an update restart that lands just before it begins, scrolling back through a conversation no longer stops early at a stand-in Jolo hides, and a resumed Jolo run that pauses again while finishing its commands is still told what others said meanwhile.
- Changing Claude's model while Claude is reporting background work by itself, and another agent holds the conversation, no longer drops that report: the next message is answered after it, and the one after that on the new model.
- A new message no longer kills the background agents and workflows Claude is running: one process serves the whole conversation. Stop ends Claude's turn and drops whatever was waiting to run. With no window open the engine stays up while that work runs, and a reload or stop waits for it.
- A message with large images no longer crashes Claude's process, a dozen or more kept conversations no longer lose Jolo's own tools, a long answer Claude gives by itself while the conversation is busy is kept whole, and an idle process whose background work is still running is not closed for being quiet.
- A turn Claude begins by itself no longer shows a stand-in message from you, and one that only answered background work's question finishes without a notification. After Claude compacts its context, what it replays is not shown again, and a message your own hook blocks ends at once with the reason.
- A question from background work while Claude is idle (a subagent, the sandbox's network check) gets a short run that ends once it is answered. "Allow for this run" on such a question covers that background work and the helpers it runs, not other background agents, "allow for this run/project" also answers the other open questions it covers and resumes runs paused on them, and with nobody to ask a run pauses on its own question, never on background work's, and never while it is still working.
- Budgets count Claude's work and not time spent only waiting on you: a foreground subagent (or one of its own) or a queued command waiting on a question costs nothing, while a model still streaming, another foreground subagent still working, or background work's question beside them does. Every model call counts once, including tool-only calls but not ones replayed from before the run took the turn.
- What each agent is told: a turn stopped after Claude took it up is not handed back to Claude as news, other agents' messages stay owed however many of Claude's own turns follow, a new Claude thread is told Claude's earlier carrying-on, switching a task's agent starts each agent's next thread from the whole conversation, and a resumed Jolo run is told what others said while it was paused, even when a command of its own runs first.
- Turns Jolo starts by itself (Claude carrying on, heartbeats) run on the model and effort chosen for the task; Claude's own /model, /effort and /fast are answered by Jolo, pointing to its model menu, as the kept process would drift from it; a slash command no longer marks what other agents said as delivered to Claude; removing a folder closes its tasks' agent processes.
- Clients can follow what a conversation's Claude process is doing: a `session.activity` event (for subscribers that declare it) reports whether it is answering, working in the background or idle, with the background tasks it runs and lately finished and their usage, at most four times a second while they progress; the `session.activity` method answers the same for a client that joins meanwhile.
- Stop now ends only Claude's turn and what waits behind it: background agents and workflows keep running, listed in the conversation's activity, until you stop them. `session.stopTask` stops one task, and `session.stopBackground` stops them all, interrupting Claude if any is still running a few seconds later, or at once when this Claude Code cannot stop tasks.

## [0.2.5] — 2026-09-14

- Added terminal themes to the CLI: a `/themes` picker, `jolo theme` management commands, and custom JSON themes that reload live.
- Added slash-command suggestions: type `/` to browse, filter, and complete composer commands.
- Kept desktop side-panel tabs per workspace, added file-link previews and a browser activity cursor, and made chat file errors clearer.
- Added Markdown table rendering and richer file-reference links in chat.
- Fixed the model harness restarting a run as new when a compaction happened inside it, moved checkpoint notes to the head of the retained context, made the iteration budget per attempt, and hardened provider stream limits.

## [0.2.4] — 2026-09-13

- Closing the last panel tab now closes the panel, including with the keyboard shortcut.
- Task and folder attention now follows the current prompt instead of superseded paused or failed runs.
- Fixed the README terminal animation and added matching light and dark themes with reduced-motion support.
- Enabled automatic npm publishing through GitHub Actions and scheduled Homebrew release updates.

## [0.2.3] — 2026-09-13

- Added Windows and Linux desktop release builds, npm CLI distribution, and Homebrew tap automation.
- Added shareable Access chats and improved chat synchronization.
- Fixed CLI cursor and word navigation, Devin cancellation, and task-specific change summaries.
- Improved desktop file links, previews, panel tabs, keyboard shortcuts, and stopped-task icons.
- Added the CLI demo, website comparison pages, and release history.

## [0.2.1] — 2026-09-13

- Redesigned Access chats and improved mobile website layouts.
- Desktop previews and workflow fixes.

## [0.2.0] — 2026-09-12

- Added changes cards tied to completed replies, so finished work is easy to inspect.
- Added Devin CLI integration.
- Added account chat sync and polished account and task interfaces.
- Replaced the reasoning-effort icon with a clear label.
- Fixed visualization rendering for Devin replies.

## [0.1.4] — 2026-09-12

- Fixed agent discovery for agents installed outside a login shell (e.g. launched from Finder).
- Website release downloads now refresh automatically.

## [0.1.3] — 2026-09-12

- Fixed file links and visualization controls.
- Redesigned the Access task editor with Markdown and added a desktop task rail.
- Added support for chat file attachments.
- Fixed ACP model effort discovery and refined the model selector.
- Improved CLI themes.

## [0.1.2] — 2026-09-12

- Refined desktop controls and scoped task numbers to workspaces.
- Added the public Jolo guide with animated desktop walkthroughs (docs.jolo.build).
- Added orchestrator plans and desktop examples to the website.
- Linked documentation from website navigation on desktop and mobile.

## [0.1.1] — 2026-09-11

- macOS DMGs are now built and published in GitHub Actions.
- Added a multi-provider model harness with portable reasoning replay.
- Added Access task comments and Google sign-in.
- Added persistent light and dark themes to Access.
- Fixed website startup being blocked by optional analytics.

## [0.1.0] — 2026-09-10

- Initial open-source release: desktop app, terminal CLI, local engine, and Jolo Access.

[0.2.5]: https://github.com/jolo-build/jolo/releases/tag/v0.2.5
[0.2.4]: https://github.com/jolo-build/jolo/releases/tag/v0.2.4
[0.2.3]: https://github.com/jolo-build/jolo/releases/tag/v0.2.3
[0.2.1]: https://github.com/jolo-build/jolo/releases/tag/v0.2.1
[0.2.0]: https://github.com/jolo-build/jolo/releases/tag/v0.2.0
[0.1.4]: https://github.com/jolo-build/jolo/releases/tag/v0.1.4
[0.1.3]: https://github.com/jolo-build/jolo/releases/tag/v0.1.3
[0.1.2]: https://github.com/jolo-build/jolo/releases/tag/v0.1.2
[0.1.1]: https://github.com/jolo-build/jolo/releases/tag/v0.1.1
[0.1.0]: https://github.com/jolo-build/jolo/releases/tag/v0.1.0
