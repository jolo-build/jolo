import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';

export async function runStandaloneChatsSmoke({ window, bridge, project, results, evaluate: rawEvaluate, waitFor, report }) {
  const evaluate = async code => {
    try { return await rawEvaluate(code); }
    catch (error) { throw new Error(`Chat check failed at ${code}: ${error.message}`); }
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const state = () => evaluate('window.__joloSmoke.state()');
  const submit = async text => {
    await evaluate('document.querySelector(".pane-slot.focused textarea").focus()');
    await window.webContents.insertText(text);
    await evaluate('document.querySelector(".pane-slot.focused .composer").requestSubmit()');
    await waitFor(`window.__joloSmoke.state().runState === 'completed' && window.__joloSmoke.state().assistantText.includes(${JSON.stringify(text)})`, 'standalone reply');
  };
  await waitFor('Boolean(document.querySelector(".sidebar .new-chat:not(:disabled)"))', 'new chat available without a folder');
  assert(!(await state()).projectId, 'Fresh start unexpectedly requires a project');
  await evaluate('document.querySelector(".sidebar .new-chat").click()');
  await waitFor('window.__joloSmoke.state().standalone && Boolean(window.__joloSmoke.state().sessionId)', 'standalone chat created');
  const first = await state();
  assert(await evaluate('document.querySelectorAll(".sidebar-workspace").length === 0'), 'Chat appeared as a workspace folder');
  assert(await evaluate('!document.querySelector(".composer textarea").disabled'), 'Chat composer requires a project');
  assert(await evaluate(`!document.querySelector('.sidebar .recent-chat[data-session-id="${first.sessionId}"]')`), 'An unsent chat is listed in the sidebar');
  await submit('Help me plan my weekend');
  await waitFor('document.querySelector(".header-task-title").textContent === "Help me plan my weekend"', 'chat gets its first-message title');
  await waitFor(`Boolean(document.querySelector('.sidebar .recent-chat[data-session-id="${first.sessionId}"]'))`, 'a chat is listed as soon as it is sent');
  await evaluate('document.querySelector(".sidebar .new-chat").click()');
  await waitFor(`window.__joloSmoke.state().standalone && window.__joloSmoke.state().sessionId !== ${JSON.stringify(first.sessionId)}`, 'second standalone chat');
  assert((await state()).workspaceId !== first.workspaceId, 'Independent chats share working storage');
  const recent = `.sidebar .recent-chat[data-session-id="${first.sessionId}"]`;
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(recent)}))`, 'first chat listed in Recents');
  await evaluate(`document.querySelector(${JSON.stringify(recent)}).click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(first.sessionId)} && window.__joloSmoke.state().messageCount > 0`, 'recent chat reopened');
  await submit('Suggest something outdoors');
  await evaluate(`document.querySelector('.header [aria-label="Panels"]').click()`);
  await waitFor(`Boolean(document.querySelector('.panel-menu:popover-open [aria-label="Split right"]'))`, 'panels menu offers Split right');
  await evaluate(`document.querySelector('.panel-menu:popover-open [aria-label="Split right"]').click()`);
  await waitFor('window.__joloSmoke.panes().length === 2 && window.__joloSmoke.state().standalone && Boolean(window.__joloSmoke.state().sessionId)', 'split creates another standalone chat');
  assert((await state()).workspaceId !== first.workspaceId, 'Split reuses the source chat storage');
  await evaluate('window.__joloSmoke.closePane(window.__joloSmoke.layout().active)');
  await bridge.rawCall('project.open', { path: project });
  await evaluate('window.__joloSmoke.refreshBoard()');
  await waitFor('document.querySelectorAll(".sidebar-workspace").length === 1', 'only the actual workspace is a folder');
  await evaluate('document.querySelector(".sidebar-workspace-new").click()');
  await waitFor('!window.__joloSmoke.state().standalone && Boolean(window.__joloSmoke.state().sessionId)', 'workspace task creation still works');
  const workspaceTask = await state();
  const { session: backgroundChat } = await bridge.rawCall('session.create', {
    projectId: workspaceTask.projectId, workspaceId: workspaceTask.workspaceId, title: 'Background Claude task', agentId: 'claude',
  });
  const { run: backgroundRun } = await bridge.rawCall('run.start', { sessionId: backgroundChat.id, requestId: 'concurrent-background', prompt: 'run echo background-task' });
  await waitFor(`window.jolo.call('run.snapshot', {runId:${JSON.stringify(backgroundRun.id)}}).then(reply => reply.result.run.state === 'awaiting_permission')`, 'background Claude task is active');
  await evaluate("window.__joloSmoke.pickAnswerer('claude')");
  await waitFor("window.__joloSmoke.state().answerer === 'Claude Code'", 'new task selects the same agent');
  assert(await evaluate("!document.querySelector('.composer textarea').placeholder.includes('Queue')"), 'another chat makes the new composer busy');
  await submit('Explain how TCP/IP works');
  assert((await bridge.rawCall('run.snapshot', { runId: backgroundRun.id })).run.state === 'awaiting_permission', 'the new chat interrupted the background task');
  assert(await evaluate("!document.querySelector('.message-queue')"), 'independent chat was queued behind the background task');
  await bridge.rawCall('run.cancel', { runId: backgroundRun.id });
  report.checks.push('a new Claude chat sends and receives a reply while another Claude task in the same folder is active, without queueing or interrupting it');
  // Compact sits in the usage panel for the agent answering here, and asks Claude to compact in its own terms.
  await waitFor("window.__joloSmoke.state().runState === 'completed'", 'Claude reply settled');
  await evaluate("document.querySelector('.composer .usage-ring').click()");
  await waitFor("Boolean(document.querySelector('.usage-panel .usage-compact'))", 'Compact offered for Claude');
  await evaluate("document.querySelector('.usage-panel .usage-compact').click()");
  await waitFor("!document.querySelector('.usage-panel') && window.__joloSmoke.state().runState === 'completed' && window.__joloSmoke.state().assistantText.includes('Context compacted.')", 'Claude compacted its context');
  report.checks.push('Compact in the usage panel asks Claude to compact its context and the task notes it');
  // Typing "/" alone lists the answering agent's own commands; Enter completes the highlighted one into the message and sends nothing.
  const key = code => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: code }); if (code === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: code }); };
  const runsBefore = (await state()).runCount;
  assert(await evaluate('!document.querySelector(".mention-list")'), 'A command list is visible before "/" is typed');
  await evaluate('document.querySelector(".pane-slot.focused textarea").focus()');
  await window.webContents.insertText('/');
  await waitFor(`[...document.querySelectorAll('.mention-list [role="option"] .mention-name')].map(el => el.textContent).join(' ') === '/compact /deploy'`, 'typing "/" lists the agent’s commands');
  assert(await evaluate(`document.querySelector('.mention-list [role="option"][aria-selected="true"] .mention-detail').textContent.startsWith('Free up context')`), 'Commands come without their one-line description');
  key('Down');
  await waitFor(`document.querySelector('.mention-list [role="option"][aria-selected="true"] .mention-name').textContent === '/deploy'`, 'arrow keys move along the commands');
  key('Enter');
  await waitFor(`document.querySelector('.pane-slot.focused textarea').value === '/deploy ' && !document.querySelector('.mention-list')`, 'Enter completes the highlighted command');
  assert((await state()).runCount === runsBefore, 'Completing a command sent a message');
  await evaluate(`(() => { const input = document.querySelector('.pane-slot.focused textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  report.checks.push('typing "/" in an empty message lists the agent’s slash commands with descriptions; arrows move and Enter completes the chosen one without sending');
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(recent)}))`, 'chats stay available from workspace');
  await evaluate(`document.querySelector(${JSON.stringify(recent)}).click()`);
  await waitFor('window.__joloSmoke.state().standalone && window.__joloSmoke.state().runCount === 2', 'chat preserves both turns');
  for (const theme of /** @type {const} */ (['dark', 'light'])) {
    nativeTheme.themeSource = theme;
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    writeFileSync(path.join(results, `standalone-chat-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  assert(await evaluate('!document.querySelector(".header").textContent.includes("chat-") && !document.querySelector(".sidebar").textContent.includes("/data/")'), 'Internal working directory leaked into chat navigation');
  for (const shortcut of [{ keyCode: 'F5' }, { keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] }]) {
    await evaluate('window.__reloadSentinel = true; document.querySelector(".composer textarea").focus()');
    window.webContents.focus();
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Desktop did not reload for ${shortcut.keyCode}`)), 10000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(null); });
    });
    window.webContents.sendInputEvent({ type: 'keyDown', ...shortcut });
    window.webContents.sendInputEvent({ type: 'keyUp', ...shortcut });
    await loaded;
    await waitFor('Boolean(window.__joloSmoke) && Boolean(document.querySelector(".sidebar .recent-chat"))', 'Chats survive keyboard reload');
    assert(await evaluate('!window.__reloadSentinel'), 'Shortcut refreshed data without reloading the application document');
    await evaluate(`document.querySelector('.sidebar .recent-chat[data-session-id="${first.sessionId}"]').click()`);
    await waitFor('window.__joloSmoke.state().standalone && window.__joloSmoke.state().runCount === 2', 'history survives keyboard reload');
  }
  // Claude's own subagents stand on their own line: their purpose, kind and model, what they are doing, then their report.
  const { session: reviewChat } = await bridge.rawCall('session.create', { projectId: workspaceTask.projectId, workspaceId: workspaceTask.workspaceId, title: 'Subagent review', agentId: 'claude' });
  await evaluate(`window.__joloSmoke.openTarget(${JSON.stringify(project)}, ${JSON.stringify(reviewChat.id)})`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(reviewChat.id)}`, 'subagent chat open');
  const { run: reviewRun } = await bridge.rawCall('run.start', { sessionId: reviewChat.id, requestId: 'subagent-review', prompt: 'subagent-review' });
  await waitFor("Boolean(window.__joloSmoke.state().pendingPermission) && document.querySelector('.subagent.working .subagent-title')?.textContent === 'Review the code' && document.querySelector('.subagent.working .subagent-meta')?.textContent === 'code-reviewer · Opus 5.5' && document.querySelector('.subagent-now')?.textContent === 'echo child-review'", 'working subagent shows its model and current tool');
  await bridge.rawCall('permission.resolve', { permissionId: (await state()).pendingPermission, decision: 'deny' });
  await waitFor(`window.jolo.call('run.snapshot', {runId:${JSON.stringify(reviewRun.id)}}).then(reply => reply.result.run.state === 'completed')`, 'subagent review finished');
  await evaluate("document.querySelector('.subagent-block summary').click()");
  await waitFor("document.querySelector('.subagent-report')?.textContent.includes('INTERNAL_REVIEW') && document.querySelectorAll('.subagent-steps li').length === 2 && !document.querySelector('.subagent-now') && !document.querySelector('.activity-group')?.textContent.includes('Agent')", 'finished subagent opens to its tools and report');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(path.join(results, 'subagent.png'), (await window.webContents.capturePage()).toPNG());
  report.checks.push("Claude's own subagent shows on its own line with its kind and model, says what it is doing while it works, and opens to its tools and report");
  report.checks.push('F5 and Cmd/Ctrl+R from the composer reload the whole application document and retain chat history');
  report.checks.push('New chat works without a folder, receives replies, gets a title, and reopens from Recents with both turns after reload');
  report.checks.push('workspace folders remain separate from chats; folder task creation and standalone split panes both work');
  writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
}
