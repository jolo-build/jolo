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
  await waitFor('Boolean(document.querySelector(".board-chat-actions button:not(:disabled)"))', 'new chat available without a folder');
  assert(!(await state()).projectId, 'Fresh start unexpectedly requires a project');
  await evaluate('document.querySelector(".board-chat-actions button").click()');
  await waitFor('window.__joloSmoke.state().standalone && Boolean(window.__joloSmoke.state().sessionId) && window.__joloSmoke.state().view === "task"', 'standalone chat created');
  const first = await state();
  assert(await evaluate('document.querySelectorAll(".sidebar-workspace").length === 0'), 'Chat appeared as a workspace folder');
  assert(await evaluate('!document.querySelector(".composer textarea").disabled'), 'Chat composer requires a project');
  await submit('Help me plan my weekend');
  await waitFor('document.querySelector(".header-task-title").textContent === "Help me plan my weekend"', 'chat gets its first-message title');
  await evaluate('document.querySelector(".sidebar .new-chat").click()');
  await waitFor(`window.__joloSmoke.state().standalone && window.__joloSmoke.state().sessionId !== ${JSON.stringify(first.sessionId)}`, 'second standalone chat');
  assert((await state()).workspaceId !== first.workspaceId, 'Independent chats share working storage');
  const recent = `.sidebar .recent-chat[data-session-id="${first.sessionId}"]`;
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(recent)}))`, 'first chat listed in Recents');
  await evaluate(`document.querySelector(${JSON.stringify(recent)}).click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(first.sessionId)} && window.__joloSmoke.state().messageCount > 0`, 'recent chat reopened');
  await submit('Suggest something outdoors');
  await evaluate(`document.querySelector('.header [aria-label="Split right"]').click()`);
  await waitFor('window.__joloSmoke.panes().length === 2 && window.__joloSmoke.state().standalone && Boolean(window.__joloSmoke.state().sessionId)', 'split creates another standalone chat');
  assert((await state()).workspaceId !== first.workspaceId, 'Split reuses the source chat storage');
  await evaluate('window.__joloSmoke.closePane(window.__joloSmoke.layout().active)');
  await bridge.rawCall('project.open', { path: project });
  await evaluate('window.__joloSmoke.showBoard()');
  await waitFor('document.querySelectorAll(".board-card").length === 1', 'only the actual workspace is a folder');
  await evaluate('document.querySelector(".board-actions button").click()');
  await waitFor('window.__joloSmoke.state().view === "task" && !window.__joloSmoke.state().standalone', 'workspace task creation still works');
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
    await waitFor('Boolean(window.__joloSmoke) && Boolean(document.querySelector(".board .recent-chat"))', 'Chats survive keyboard reload');
    assert(await evaluate('!window.__reloadSentinel'), 'Shortcut refreshed data without reloading the application document');
    await evaluate(`document.querySelector('.board .recent-chat[data-session-id="${first.sessionId}"]').click()`);
    await waitFor('window.__joloSmoke.state().standalone && window.__joloSmoke.state().runCount === 2', 'history survives keyboard reload');
  }
  report.checks.push('F5 and Cmd/Ctrl+R from the composer reload the whole application document and retain chat history');
  report.checks.push('New chat works without a folder, receives replies, gets a title, and reopens from Recents with both turns after reload');
  report.checks.push('workspace folders remain separate from chats; folder task creation and standalone split panes both work');
  writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
}
