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
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(recent)}))`, 'chats stay available from workspace');
  await evaluate(`document.querySelector(${JSON.stringify(recent)}).click()`);
  await waitFor('window.__joloSmoke.state().standalone && window.__joloSmoke.state().runCount === 2', 'chat preserves both turns');
  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme;
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    writeFileSync(path.join(results, `standalone-chat-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  assert(await evaluate('!document.querySelector(".header").textContent.includes("chat-") && !document.querySelector(".sidebar").textContent.includes("/data/")'), 'Internal working directory leaked into chat navigation');
  window.webContents.reload();
  await waitFor('Boolean(window.__joloSmoke) && Boolean(document.querySelector(".board .recent-chat"))', 'Recents survives reload');
  await evaluate(`document.querySelector('.board .recent-chat[data-session-id="${first.sessionId}"]').click()`);
  await waitFor('window.__joloSmoke.state().standalone && window.__joloSmoke.state().runCount === 2', 'history survives reload');
  report.checks.push('New chat works without a folder, receives replies, gets a title, and reopens from Recents with both turns after reload');
  report.checks.push('workspace folders remain separate from chats; folder task creation and standalone split panes both work');
  writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
}
