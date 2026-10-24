# Changelog

All notable changes to Jolo are documented here. This project uses [semantic versioning](https://semver.org/) for tagged releases.

## [Unreleased]

- A new chat is named by whoever answers it, as Claude Code and Codex name theirs: its first prompt goes to that answerer's cheapest model (Claude Code's haiku, a provider's mini, nano, flash, lite or small model) and the short title it returns replaces the first 80 characters of the prompt, unless you renamed the chat meanwhile. Codex and other agents keep the prompt's first characters for now; `JOLO_AUTO_TITLE=0` turns this off.
- The terminal client shows what the desktop shows of a hosted Claude Code conversation: in the interactive client, Claude's questions and plan approvals wait in the same queue as permission requests and are answered from the keyboard (an option's number, numbers for a multi-select, your own words, Enter approves a plan and typed feedback sends it back, Esc dismisses), a client that opens the conversation while one waits is asked it at once, Enter resumes a run that paused on a question with nobody to answer it (Claude asks again), the conversation's background work shows above the composer as `Background work: N tasks · elapsed` (or `Workflow <name> · elapsed`), and Ctrl+X stops it, asking before a force stop when a stop leaves tasks running. `jolo run`, `jolo attach` and `jolo resume` from a terminal now count as an interactive client, so the run they follow waits for your answer instead of pausing: a question or plan is printed as plain text with the command that answers it, `jolo dialog answer|approve|dismiss <run-id>`, and a permission request with `jolo permission allow`; piped or with `--json` they stay headless (a `dialog_required` record names the question, and a run that pauses on one with nobody to answer it says so with `jolo resume`). They also report the conversation's background work as status lines, and a run that ends with work still running names `jolo background stop <session-id>`, whose `--force` closes a process whose tasks ignore the stop.
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
- Clients can follow what a conversation's Claude process is doing: a `session.activity` event (for subscribers that declare it) reports whether it is answering, working in the background or idle, with the background tasks it runs and lately finished and their usage, each time that changes or a task starts or ends; their progress in between (usage, phase) comes at most four times a second as a transient `activity` notification (`onActivity` in the client) that is never stored, so it does not crowd run and message events out of the reconnect history; the `session.activity` method answers the same for a client that joins meanwhile.
- Stop now ends only Claude's turn and what waits behind it: background agents and workflows keep running, listed in the conversation's activity, until you stop them. `session.stopTask` stops one task, and `session.stopBackground` stops them all and says how many ended; a Claude Code that cannot stop tasks is interrupted instead.
- Fixed Claude's questions to you (AskUserQuestion) coming back empty: asked as permission prompts, they went back to Claude without your answer. They and Claude's plan approvals (which already worked as permission prompts) now reach Jolo as dialogs: a `dialog.requested` event (for subscribers that declare it) carries what Claude asked (a preview of it past 64 KiB), `dialog.resolve` sends your answer back, `dialog.dismiss` tells Claude you did not answer, Stop tells Claude the run was stopped, and a question Jolo cannot record is refused at once rather than left waiting.
- A delegated child task is done only when its process is idle, not when its first answer arrives while its background work goes on: `delegation_status` reports the child's `activity`, `done` and `partial`, its `output` is the child's latest answer (the one it gives when that work ends included), and `waitMs` waits inside Jolo, spending no model turns, up to the new `delegation.maxWaitMs` setting (ten minutes by default, at most an hour) instead of 25 seconds, or until the child waits on you (a question, a pause), which a paused child's `done: false` also says.
- Stopping a parent run, cancelling a child with `delegation_cancel`, or cancelling a plan also stops the background tasks of the child's or the task's Claude process, which a Stop of its turn alone spares.
- A plan task is done only when its process is idle, not when its run completes while the background work it started goes on: it stays running with the summary "finishing background work", and the plan moves to the next task once that work, and Claude's report of it, has ended (or the process has). A failed, stopped or paused run still ends its task at once.
- Closing a Claude process (its task archived or deleted, its worktree removed, the model changed, the engine stopped) stops its background tasks first, so they end as stopped rather than failed; one that does not stop within a few seconds ends with the process, as before.
- The desktop app shows a conversation's background work: while its Claude process runs subagents, workflows or commands, a line above the composer reads `Background work: N tasks · tokens · elapsed` (while a workflow runs, `Workflow <name>: <phase> <done>/<agents> · elapsed · tokens`, or `Workflow <name> · elapsed · tokens` until Claude Code reports its agents), and the Activity panel (Panels menu), laid out like Claude Code's own Background tasks panel, lists the running tasks and then, under `Finished N`, the finished ones, each newest first: a task as a row with its kind (command, agent, task), status, elapsed time, tokens and tool uses, and each workflow run as a card with its name, status, elapsed time, agent count and tokens, a `Large` badge past 25 agents, and its phases from Claude Code's own progress report, each with its finished agents and a square per agent (done, running, failed or pending, and stopped once the workflow was stopped). Clear finished hides the finished tasks listed at that moment. A token count of 0, before any agent has reported spend, is not shown. A finished run whose process still runs background work is announced as `answered · background work running`, quietly, not as done.
- The Activity panel shows what Claude Code's stream says about each task: while it runs, what it does now (its progress line, else the tool it last used); once it ended, Claude's summary when it says more than the description, and its output file by name (the full path on hover); a subagent's own commands drawn under it with `↳`; and in a workflow card, each phase's chevron opens one line per agent with its model, tokens, duration and state, and a preview of its result, the phase staying open when the card moves under `Finished N`. A subagent Claude Code reports `killed` is recorded as stopped. `session.activity` task records carry `parentTaskId`, `spawnDepth`, `lastTool`, `progress`, `summary` and `outputFile`, a workflow's phases their `index`, and its summary its latest 200 agents (`agents.list`, each with its phase's index); an activity that would not fit in one message leaves out agent lists, finished workflows' first, then the oldest finished tasks, never a running one.
- Stop background work, on that line and in the Activity panel, stops all of a conversation's background tasks; each running task and each workflow card has its own square stop button at its right end, as Claude Code's own panel has.
- Where Claude called its `Workflow` tool, the conversation shows the workflow as a compact card instead of a raw tool line: its name, `Workflow`, its agent count and elapsed time (and how it ended), and one square per agent across its phases, live from the Activity; its chevron opens the Activity panel. The card finds its task by the workflow's name among the tasks started during its own turn. When a stop leaves tasks running, the panel offers Force stop, which after a confirmation closes the process (`session.closeProcess`), ending its background work and any answer in progress; the next message starts a fresh process.
- Claude's questions (AskUserQuestion) and plan approvals (ExitPlanMode) open in the desktop app as cards beside the permission card, and the answer goes back as Claude expects it: `answers` keyed by question, a multi-select's labels joined by `, `, free text through Other; a plan is approved with Approve plan or sent back with Send back and optional feedback. A client that joins while one is open gets it from `session.page`'s new `pendingDialogs`, and the app notifies about a question or plan as it does about an approval (`<project> needs your answer`).
- In the desktop app, each of Jolo's delegation calls shows in the parent's transcript as one line for the child it is about, saying what that child is doing (its state, whether its process is working or running background work, a partial answer, why a wait ended) with an Open button into its conversation; the child-tasks list says the same for each child.
- `delegation_status` now reports `wakeReason`, why its wait ended: `done`, `answer` (a newer answer), `asking` (the child waits on you), `parent_stopped`, `stopped` (the call itself was stopped) or `timeout`.
- Messages in the desktop chat have a copy button and say when they were sent (`5m ago`, the exact date and time on hover), shown when you hover or focus a message (always on a touch screen) without moving anything. `session.page` messages and the `message.started` event carry `createdAt`, which an older engine leaves out.

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
