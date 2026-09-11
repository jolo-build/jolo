// Native input must reload the application regardless of which panel has focus.
import { selectPanel } from './panel-controls.js';
export async function runReloadSmoke({ window, bridge, browserHost, project, fixtureUrl, evaluate, waitFor, report }) {
  const initial = await evaluate('window.__joloSmoke.state()');
  const { session } = await bridge.rawCall('session.create', { projectId: initial.projectId, workspaceId: initial.workspaceId, title: 'Reload panel check' });
  const { session: background } = await bridge.rawCall('session.create', { projectId: initial.projectId, workspaceId: initial.workspaceId, title: 'Background run', agentId: 'claude' });
  const { run } = await bridge.rawCall('run.start', { sessionId: background.id, requestId: 'reload-background', prompt: 'run echo awaiting-approval' });
  await waitFor(`window.jolo.call('run.snapshot', {runId:${JSON.stringify(run.id)}}).then(reply => reply.result.run.state === 'awaiting_permission')`, 'background run waiting');
  const boot = (await bridge.rawCall('engine.status', {})).engineBootId;
  const cases = ['changes', 'browser address', 'blank browser page', 'browser page', 'changes with retained browser'];
  try {
    for (const panel of cases) {
      for (const shortcut of [{ keyCode: 'F5' }, { keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] }]) {
        await evaluate(`window.__joloSmoke.openTarget(${JSON.stringify(project)}, ${JSON.stringify(session.id)})`);
        await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(session.id)} && Boolean(document.querySelector('.composer'))`, 'chat reopened');
        let input = window.webContents;
        if (panel !== 'changes') {
          await evaluate(`window.__joloSmoke.openBrowser(${panel === 'blank browser page' ? '' : JSON.stringify(fixtureUrl)})`);
          await waitFor('Boolean(document.querySelector("webview"))', 'browser mounted');
          const deadline = Date.now() + 5000;
          while (![...browserHost.guests.values()].length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          const guest = [...browserHost.guests.values()][0]?.guest;
          if (!guest) throw new Error('browser guest did not attach');
          while ((!guest.getURL() || guest.isLoading()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          if (panel === 'browser address') {
            await evaluate('document.querySelector(".browser-bar input").focus()');
            window.webContents.focus();
          } else {
            guest.focus();
            input = guest;
          }
        }
        if (panel.startsWith('changes')) {
          await selectPanel(evaluate, waitFor, 'Changes');
          await waitFor('document.querySelector(".changes-host")?.hidden === false', 'Changes visible');
          // Retain guest focus to exercise the stale focus that used to survive tab switching.
          if (panel === 'changes') {
            await evaluate('document.querySelector(".context-tabs [role=tab][aria-selected=true]").focus()');
            window.webContents.focus();
          }
        }
        await evaluate('window.__panelReloadSentinel = true');
        let loaded;
        const completed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { window.webContents.removeListener('did-finish-load', loaded); reject(new Error(`${panel}: ${shortcut.keyCode} did not reload the desktop`)); }, 10000);
          loaded = () => { clearTimeout(timer); resolve(null); };
          window.webContents.once('did-finish-load', loaded);
        });
        input.sendInputEvent({ type: 'keyDown', ...shortcut });
        input.sendInputEvent({ type: 'keyUp', ...shortcut });
        await completed;
        await waitFor('Boolean(window.__joloSmoke) && Boolean(document.querySelector(".board")) && !window.__panelReloadSentinel', 'whole application reloaded');
        if ((await bridge.rawCall('engine.status', {})).engineBootId !== boot) throw new Error('UI refresh restarted the engine');
        if ((await bridge.rawCall('run.snapshot', { runId: run.id })).run.state !== 'awaiting_permission') throw new Error('UI refresh interrupted the background run');
        if ((await bridge.rawCall('session.page', { sessionId: session.id })).session.title !== 'Reload panel check') throw new Error('UI refresh lost the selected task');
      }
      report.checks.push(`F5 and Cmd/Ctrl+R reload the entire desktop from ${panel}, preserving the engine and its background run`);
    }
  } finally { await bridge.rawCall('run.cancel', { runId: run.id }); }
}
