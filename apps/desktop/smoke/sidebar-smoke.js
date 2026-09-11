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
  const checkHeader = async () => {
    const bounds = await evaluate(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right }; };
      return { brand: rect('.header-brand'), logo: rect('.header-brand .jolo-mark'), toggle: rect('.sidebar-toggle'), workspace: rect('.header-workspace') };
    })()`);
    assert(bounds.logo.left >= bounds.brand.left && bounds.logo.right <= bounds.toggle.left && bounds.toggle.right < bounds.brand.right && bounds.brand.right <= bounds.workspace.left,
      'header controls overlap the divider or each other: ' + JSON.stringify(bounds));
  };
  await settle();
  await checkHeader();
  const initial = await measure();
  const point = await evaluate(`(() => { const r=document.querySelector('.sidebar-divider').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+100)}; })()`);
  // Target Chromium directly: Electron sendInputEvent can silently lose the drag
  // when another application owns macOS focus. CDP still exercises real pointer capture.
  const debuggerApi = window.webContents.debugger;
  const attachedHere = !debuggerApi.isAttached();
  if (attachedHere) debuggerApi.attach('1.3');
  try {
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await settle();
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 90, y: point.y, button: 'left', buttons: 1 });
    await settle();
  } finally {
    try { await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 90, y: point.y, button: 'left', buttons: 0, clickCount: 1 }); }
    finally { if (attachedHere) debuggerApi.detach(); }
  }
  await settle();
  const resized = await measure();
  assert(resized.sidebar >= initial.sidebar + 80 && resized.sidebar === resized.header && resized.paneLeft === resized.sidebar, `sidebar drag did not resize aligned header and workspace: ${JSON.stringify({initial,resized,point})}`);
  await evaluate("(() => { const divider = document.querySelector('.sidebar-divider'); divider.focus(); divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); })()");
  await settle();
  assert((await measure()).sidebar === resized.sidebar - 16, 'sidebar divider keyboard resize failed');
  await evaluate("window.__sidebarComposer = document.querySelector('.composer textarea'); document.querySelector('.sidebar-toggle').click()");
  await settle();
  assert((await measure()).sidebar === 0 && (await measure()).paneLeft === 0, 'collapsed sidebar still uses workspace space');
  assert(await evaluate("document.querySelector('.workspace-sidebar').inert && window.__sidebarComposer === document.querySelector('.composer textarea')"), 'collapsing sidebar lost composer or left hidden controls active');
  window.webContents.reload();
  await waitFor("Boolean(window.__joloSmoke)", 'workspace reloaded');
  await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(project)})`);
  await waitFor("Boolean(document.querySelector('.sidebar-toggle'))", 'chat sidebar restored');
  await settle();
  assert(await evaluate("document.querySelector('.sidebar-toggle').getAttribute('aria-expanded') === 'false'"), 'collapsed sidebar preference was lost on reload');
  // Both the logo and toggle remain visible when collapsed. Their intrinsic width
  // must fit beside the workspace breadcrumb, including at the narrow breakpoint.
  const fullSize = window.getSize();
  try {
    for (const width of [fullSize[0], 800]) {
      window.setSize(width, fullSize[1]); await settle(); await checkHeader();
    }
  } finally { window.setSize(...fullSize); await settle(); }
  await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(project)})`);
  await waitFor('window.__joloSmoke.state().projectId', 'sidebar test project reopened');
  const originalTheme = nativeTheme.themeSource;
  try {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme; await settle();
      writeFileSync(path.join(results, `sidebar-collapsed-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true, bubbles: true, cancelable: true }))`);
    await settle();
    assert((await measure()).sidebar === resized.sidebar - 16, 'sidebar shortcut did not restore remembered width');
    await checkHeader();
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
  report.checks.push('Header logo and sidebar toggle fit inside their column without crossing the divider in expanded and collapsed layouts, including a narrow window');
}
