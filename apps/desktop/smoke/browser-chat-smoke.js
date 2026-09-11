// Real renderer -> chat run -> engine tools -> host -> Chromium. No UI opener or
// direct navigation is called by the test: the scripted agent must do both.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runRealBrowserAgentSmoke({ window, bridge, browserHost, fixtureUrl, evaluate, waitFor, report, results, agentId }) {
  const state = await evaluate('window.__joloSmoke.state()');
  const { session } = await bridge.rawCall('session.create', { projectId: state.projectId, workspaceId: state.workspaceId, agentId, title: 'Inline browser integration check' });
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(session.id)})`);
  await evaluate('window.__joloSmoke.showTask()');
  await waitFor(`document.querySelector('.model-select')?.textContent.includes(${JSON.stringify(agentId)})`, 'real agent selected');
  for (const attempt of ['first', 'resumed']) {
    if (browserHost.guests.size) await evaluate('window.__joloSmoke.closeBrowser()');
    await waitFor("!document.querySelector('webview')", 'browser starts closed');
    const runsBefore = await evaluate('window.__joloSmoke.state().runCount');
    await evaluate(`window.__joloSmoke.send(${JSON.stringify(`Open ${fixtureUrl} in Jolo's inline browser, click the Click button, and take a screenshot. Confirm the button says Clicked. This is a browser integration test; do not edit files.`)})`);
    await waitFor(`window.__joloSmoke.state().runCount > ${runsBefore} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, `${agentId} browser run finished`, 120_000);
    const page = await bridge.rawCall('session.page', { sessionId: session.id });
    const run = page.runs.at(-1);
    if (run.state !== 'completed') throw new Error(`${agentId} browser run ${run.state}: ${JSON.stringify(run.failure)}`);
    const texts = await Promise.all(page.messages.filter(message => message.runId === run.id && message.kind === 'tool').map(async message => (await bridge.rawCall('artifact.read', { artifactId: message.artifactId })).text));
    if (texts.some(text => /^cua_repl\/|^computer[-_]use\//.test(text))) throw new Error('agent used computer use for the inline browser');
    for (const name of ['browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_screenshot']) if (!texts.some(text => text.includes(name))) throw new Error(`${agentId} did not call ${name}: ${texts.join('\n').slice(0,2500)}`);
    const guest = [...browserHost.guests.values()][0]?.guest;
    if (!guest || await guest.executeJavaScript("document.querySelector('button')?.textContent") !== 'Clicked') throw new Error('agent did not control the inline page');
    writeFileSync(path.join(results, `browser-${agentId}-${attempt}.png`), (await window.webContents.capturePage()).toPNG());
    report.checks.push(`${agentId} ${attempt} turn opened the inline browser, navigated, inspected, clicked, and captured a screenshot through Jolo tools without computer use`);
  }
}

export async function runBrowserChatSmoke({ bridge, browserHost, fixtureUrl, evaluate, waitFor, report }) {
  if (browserHost.guests.size || await evaluate("Boolean(document.querySelector('webview'))")) throw new Error('browser must start closed for the chat-opening test');
  const runsBefore = await evaluate('window.__joloSmoke.state().runCount');
  await evaluate(`window.__joloSmoke.send(${JSON.stringify(`Open ${fixtureUrl} in the inline browser, click the button, and take a screenshot.`)})`);
  await waitFor(`window.__joloSmoke.state().runCount > ${runsBefore} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, 'browser run finished', 30_000);
  const state = await evaluate('window.__joloSmoke.state()');
  if (state.runState !== 'completed') throw new Error(`browser run ended ${state.runState}: ${state.toolText.slice(0, 1200)}`);
  await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page' && !document.querySelector('.browser-start')", 'chat opened and navigated the inline browser');
  if (!state.assistantText.includes('Clicked the button.')) throw new Error(`unexpected browser-run text: ${state.assistantText}`);
  const guest = [...browserHost.guests.values()][0]?.guest;
  let buttonText;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    buttonText = await guest.executeJavaScript("document.querySelector('button').textContent");
    if (buttonText === 'Clicked') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (buttonText !== 'Clicked') throw new Error(`agent click did not reach the page: ${buttonText}`);
  if (!state.toolText.includes('"artifactId"') || !state.toolText.includes('browser_screenshot')) throw new Error('screenshot tool result missing');
  if (!state.toolText.includes('browser_network') || !state.toolText.includes(`"url":"${fixtureUrl}"`)) throw new Error(`network observation missing: ${state.toolText.slice(-600)}`);
  if (![...bridge.agent.hosts.values()].some(host => host.capabilityId)) throw new Error('browser host did not register');
  report.checks.push('Chat alone opened the closed inline browser, navigated, snapshotted, clicked a real element, and captured a screenshot through the engine broker');
}

export async function runBrowserContentionSmoke({ browserHost, project, evaluate, waitFor, report }) {
  const original = [...browserHost.guests.values()][0].guest;
  const url = original.getURL();
  const originalWorkspace = await evaluate('window.__joloSmoke.state().workspaceId');
  const otherProject = path.join(path.dirname(project), 'other-browser-workspace');
  mkdirSync(otherProject, { recursive: true });
  const paneId = await evaluate('window.__joloSmoke.split()');
  try {
    await waitFor(`window.__joloSmoke.layout().active === ${JSON.stringify(paneId)} && window.__joloSmoke.state().projectId`, 'second pane ready');
    await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(otherProject)})`);
    await waitFor(`window.__joloSmoke.state().workspaceId && window.__joloSmoke.state().workspaceId !== ${JSON.stringify(originalWorkspace)}`, 'other workspace ready');
    await evaluate("window.__joloSmoke.send('Open the inline browser in this workspace.')");
    await waitFor("['completed','failed','paused'].includes(window.__joloSmoke.state().runState)", 'competing browser run finished');
    const state = await evaluate('window.__joloSmoke.state()');
    if (!state.toolText.includes('browser_open') || !state.toolText.includes('"code":"conflict"')) throw new Error(`competing browser open was not rejected as busy: ${state.toolText.slice(0, 1200)}`);
    if (original.isDestroyed() || browserHost.guests.size !== 1 || original.getURL() !== url) throw new Error('competing chat replaced the first browser');
    if (await original.executeJavaScript("document.querySelector('button').textContent") !== 'Clicked') throw new Error('competing chat changed the first browser page');
    report.checks.push('A second workspace chat received a busy error and preserved the first browser guest, URL, and page state');
  } finally { await evaluate(`window.__joloSmoke.closePane(${JSON.stringify(paneId)})`); }
}
