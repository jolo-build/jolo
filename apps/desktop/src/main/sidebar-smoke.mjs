import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';

export async function runSidebarSmoke({ window, results, project, evaluate, waitFor, report }) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const measure = () => evaluate(`(() => {
    const sidebar = document.querySelector('.workspace-sidebar').getBoundingClientRect();
    const brand = document.querySelector('.header-brand').getBoundingClientRect();
    const pane = document.querySelector('.pane-canvas').getBoundingClientRect();
    return { sidebar: sidebar.width, header: brand.width, paneLeft: pane.left, paneWidth: pane.width };
  })()`);
  await settle();
  const initial = await measure();
  const point = await evaluate(`(() => { const r=document.querySelector('.sidebar-divider').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+100)}; })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  await settle(); // Let Chromium establish pointer capture before moving the divider.
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 90, y: point.y });
  await settle();
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 90, y: point.y, button: 'left', clickCount: 1 });
  await settle();
  const resized = await measure();
  assert(resized.sidebar >= initial.sidebar + 80 && resized.sidebar === resized.header && resized.paneLeft === resized.sidebar, `sidebar drag did not resize aligned header and workspace: ${JSON.stringify({initial,resized,point})}`);
  await evaluate("document.querySelector('.sidebar-divider').focus()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
  await settle();
  assert((await measure()).sidebar === resized.sidebar - 16, 'sidebar divider keyboard resize failed');
  await evaluate("window.__sidebarComposer = document.querySelector('.composer textarea'); document.querySelector('.sidebar-toggle').click()");
  await settle();
  assert((await measure()).sidebar === 0 && (await measure()).paneLeft === 0, 'collapsed sidebar still uses workspace space');
  assert(await evaluate("document.querySelector('.workspace-sidebar').inert && window.__sidebarComposer === document.querySelector('.composer textarea')"), 'collapsing sidebar lost composer or left hidden controls active');
  window.webContents.reload();
  await waitFor("Boolean(window.__joloSmoke) && Boolean(document.querySelector('.sidebar-toggle'))", 'sidebar reloaded');
  await settle();
  assert(await evaluate("document.querySelector('.sidebar-toggle').getAttribute('aria-expanded') === 'false'"), 'collapsed sidebar preference was lost on reload');
  await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(project)})`);
  await waitFor('window.__joloSmoke.state().projectId', 'sidebar test project reopened');
  const originalTheme = nativeTheme.themeSource;
  try {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme; await settle();
      writeFileSync(path.join(results, `sidebar-collapsed-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'b', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'b', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await settle();
    assert((await measure()).sidebar === resized.sidebar - 16, 'sidebar shortcut did not restore remembered width');
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme; await settle();
      writeFileSync(path.join(results, `sidebar-expanded-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
  } finally { nativeTheme.themeSource = originalTheme; }
  await evaluate("document.querySelector('.sidebar-divider').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  await settle();
  assert((await measure()).sidebar === 194, 'sidebar reset width failed');
  report.sidebar = { initial, resized, restored: await measure() };
  report.checks.push('Sidebar drags and resizes by keyboard, collapses without remounting the composer, remembers its state through reload, and restores with Cmd/Ctrl+B in both themes');
}
