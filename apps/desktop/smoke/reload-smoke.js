// Browser refresh stays in its page; other panels still refresh the application.
import { selectPanel } from './panel-controls.js';
export async function runReloadSmoke({ window, bridge, browserHost, project, fixtureUrl, evaluate, waitFor, report }) {
  const initial = await evaluate('window.__joloSmoke.state()');
  const { session } = await bridge.rawCall('session.create', { projectId: initial.projectId, workspaceId: initial.workspaceId, title: 'Reload panel check' });
  const { session: background } = await bridge.rawCall('session.create', { projectId: initial.projectId, workspaceId: initial.workspaceId, title: 'Background run', agentId: 'claude' });
  const { run } = await bridge.rawCall('run.start', { sessionId: background.id, requestId: 'reload-background', prompt: 'run echo awaiting-approval' });
  await waitFor(`window.jolo.call('run.snapshot', {runId:${JSON.stringify(run.id)}}).then(reply => reply.result.run.state === 'awaiting_permission')`, 'background run waiting');
  const boot = (await bridge.rawCall('engine.status', {})).engineBootId;
  const cases = ['changes', 'browser address', 'blank browser page', 'browser page', 'changes with retained browser'];
  const visibleView = "[...document.querySelectorAll('.browser webview')].find(view => !view.closest('[hidden]') && view.getClientRects().length)";
  try {
    for (const panel of cases) {
      for (const [index, shortcut] of [
        { keyCode: 'F5' }, { keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] },
        { keyCode: 'F5', modifiers: ['shift'] }, { keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] },
      ].entries()) {
        await evaluate(`window.__joloSmoke.openTarget(${JSON.stringify(project)}, ${JSON.stringify(session.id)})`);
        await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(session.id)} && Boolean(document.querySelector('.composer'))`, 'chat reopened');
        let input = window.webContents;
        let guest;
        if (panel !== 'changes') {
          if (index === 0 || panel.startsWith('changes')) await evaluate(`window.__joloSmoke.openBrowser(${panel === 'blank browser page' ? '' : JSON.stringify(fixtureUrl)})`);
          else await selectPanel(evaluate, waitFor, 'Browser');
          await waitFor(`Boolean(${visibleView})`, 'browser mounted');
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const guestId = await evaluate(`(${visibleView})?.getWebContentsId()`);
            guest = browserHost.guests.get(guestId)?.guest;
            if (guest) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (!guest) throw new Error('browser guest did not attach');
          while ((!guest.getURL() || guest.isLoading()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          if (panel === 'browser address') {
            await evaluate(`(${visibleView}).closest('.browser').querySelector('.browser-bar input').focus()`);
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
            await evaluate('document.querySelector(".panel-item-tabs [role=tab][aria-selected=true]").focus()');
            window.webContents.focus();
          }
        }
        await evaluate('window.__panelReloadSentinel = true');
        const browserRefresh = !panel.startsWith('changes');
        const target = browserRefresh ? guest : window.webContents;
        const pageUrl = browserRefresh ? guest.getURL() : null;
        if (browserRefresh) await guest.executeJavaScript('window.__pageReloadSentinel = true');
        let loaded;
        const completed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { target.removeListener('did-finish-load', loaded); reject(new Error(`${panel}: ${shortcut.keyCode} did not reload the ${browserRefresh ? 'page' : 'desktop'}`)); }, 10000);
          loaded = () => { clearTimeout(timer); resolve(null); };
          target.once('did-finish-load', loaded);
        });
        input.sendInputEvent({ type: 'keyDown', ...shortcut });
        input.sendInputEvent({ type: 'keyUp', ...shortcut });
        await completed;
        if (browserRefresh) {
          if (!await evaluate('window.__panelReloadSentinel')) throw new Error('Browser refresh reloaded the desktop');
          if (guest.isDestroyed() || guest.getURL() !== pageUrl || await guest.executeJavaScript('Boolean(window.__pageReloadSentinel)')) throw new Error('Browser page did not reload in place');
          if (await evaluate('window.__joloSmoke.state().sessionId') !== session.id) throw new Error('Browser refresh changed the selected task');
        } else {
          window.webContents.focus();
          try {
            await waitFor('Boolean(window.__joloSmoke) && Boolean(document.querySelector(".board")) && !window.__panelReloadSentinel', `${panel}: ${JSON.stringify(shortcut)} whole application reloaded`);
          } catch (error) {
            throw new Error(`${error.message}; document=${await evaluate('document.body.innerText.slice(0, 500)')}`);
          }
        }
        if ((await bridge.rawCall('engine.status', {})).engineBootId !== boot) throw new Error('UI refresh restarted the engine');
        if ((await bridge.rawCall('run.snapshot', { runId: run.id })).run.state !== 'awaiting_permission') throw new Error('UI refresh interrupted the background run');
        if ((await bridge.rawCall('session.page', { sessionId: session.id })).session.title !== 'Reload panel check') throw new Error('UI refresh lost the selected task');
      }
      report.checks.push(`F5, Cmd/Ctrl+R and their hard-refresh variants reload only the ${panel.startsWith('changes') ? 'desktop' : 'browser page'} from ${panel}, preserving the engine and its background run`);
    }
  } finally { await bridge.rawCall('run.cancel', { runId: run.id }); }
}
