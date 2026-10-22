import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { SIDEBAR_DEFAULT } from '../src/renderer/sidebar-layout.js';

export async function runSidebarSmoke({ window, results, project, evaluate, waitFor, report }) {
  // The drag and hover checks drive the pointer through CDP; a real cursor resting over this window must not send its own moves meanwhile.
  window.setIgnoreMouseEvents(true);
  try { await sidebarChecks({ window, results, project, evaluate, waitFor, report }); }
  finally { window.setIgnoreMouseEvents(false); }
}

async function sidebarChecks({ window, results, project, evaluate, waitFor, report }) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const measure = () => evaluate(`(() => {
    // A collapsed sidebar keeps its width off to the side for the slide; it counts only while it peeks.
    const sidebar = document.querySelector('.app').matches('.sidebar-collapsed:not(.sidebar-peeking)') ? { width: 0 } : document.querySelector('.workspace-sidebar').getBoundingClientRect();
    const brand = document.querySelector('.header-brand').getBoundingClientRect();
    const pane = document.querySelector('.pane-canvas').getBoundingClientRect();
    return { sidebar: sidebar.width, header: brand.width, paneLeft: pane.left, paneWidth: pane.width };
  })()`);
  const checkHeader = async () => {
    const bounds = await evaluate(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right }; };
      return { brand: rect('.header-brand'), logo: rect('.header-brand .jolo-wordmark'), toggle: rect('.sidebar-toggle'), workspace: rect('.header-workspace') };
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
  assert(await evaluate("getComputedStyle(document.querySelector('.workspace-sidebar')).visibility === 'hidden'"), 'collapsing a pinned sidebar faded it over the conversation instead of hiding it at once');
  if (attachedHere) debuggerApi.attach('1.3');
  try {
    const edge = await evaluate("(() => { const r = document.querySelector('.sidebar-hover-edge').getBoundingClientRect(); return { x: 2, y: Math.round(r.top + 100) }; })()");
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...edge });
    await settle();
    assert((await measure()).sidebar === resized.sidebar - 16 && (await measure()).paneLeft === 0, 'hover did not reveal the sidebar over the workspace');
    assert(await evaluate("!document.querySelector('.workspace-sidebar').inert && document.querySelector('.sidebar-toggle').getAttribute('aria-expanded') === 'false'"), 'hover did not enable sidebar controls or changed the collapsed preference');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: edge.y });
    await settle();
    assert((await measure()).sidebar > 0, 'sidebar hid while moving into it');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resized.sidebar + 100, y: edge.y });
    await settle();
    assert((await measure()).sidebar === 0 && await evaluate("document.querySelector('.workspace-sidebar').inert"), 'sidebar did not hide after leaving');
    await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
    assert(await evaluate("getComputedStyle(document.querySelector('.workspace-sidebar')).visibility === 'hidden' && getComputedStyle(document.querySelector('.header-brand'), '::after').visibility === 'hidden'"), 'the sidebar or its header strip stayed visible after sliding out');
    // The header's sidebar button peeks as well, and the peek outlasts the trip across the header into the sidebar.
    const pause = () => new Promise(resolve => setTimeout(resolve, 450)).then(settle);
    const toggle = await evaluate("(() => { const r = document.querySelector('.sidebar-toggle').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    // The strip of header between the button and the sidebar's top edge.
    const gap = { x: Math.min(toggle.x, resized.sidebar - 40), y: await evaluate("(() => { const b = document.querySelector('.sidebar-toggle').getBoundingClientRect(), h = document.querySelector('.header-brand').getBoundingClientRect(); return Math.round((b.bottom + h.bottom) / 2); })()") };
    // The header's own bottom border, the first row above the sidebar: no drag region covers it off macOS.
    const border = { x: gap.x, y: await evaluate("Math.floor(document.querySelector('.header').getBoundingClientRect().bottom) - 1") };
    const headerLeft = () => evaluate("document.querySelector('.header-workspace').getBoundingClientRect().left");
    // Checked with no frame wait: a crossing must fit inside the leave grace even when the machine is busy.
    const peeking = () => evaluate("document.querySelector('.app').classList.contains('sidebar-peeking')");
    const collapsedHeaderLeft = await headerLeft();
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...toggle });
    await settle();
    assert((await measure()).sidebar === resized.sidebar - 16 && await evaluate("!document.querySelector('.workspace-sidebar').inert && document.querySelector('.sidebar-toggle').getAttribute('aria-expanded') === 'false'"), 'hovering the sidebar button did not reveal the sidebar');
    // One line from top to bottom: the header strip's border and the sidebar's own, and no second border on its host.
    // Layout edges, not screen rects, because both are still sliding in.
    const edges = await evaluate("(() => { const brand = document.querySelector('.header-brand'), edge = getComputedStyle(brand, '::after'), host = document.querySelector('.workspace-sidebar'), sidebar = host.querySelector('.sidebar'); return { header: brand.getBoundingClientRect().left + parseFloat(edge.left) + parseFloat(edge.width) + (edge.boxSizing === 'content-box' ? parseFloat(edge.borderRightWidth) : 0), sidebar: host.offsetLeft + sidebar.offsetLeft + sidebar.offsetWidth, hostBorder: getComputedStyle(host).borderRightWidth, stripRegion: edge.webkitAppRegion, stripPointer: edge.pointerEvents, stripLeft: parseFloat(edge.left), toggleRight: document.querySelector('.sidebar-toggle').getBoundingClientRect().right - brand.getBoundingClientRect().left }; })()");
    // CDP input skips macOS drag regions, so check the rule itself: a drag region over the sidebar button takes its hover away and the peek flickers.
    assert(edges.stripRegion === 'no-drag' && edges.stripLeft >= edges.toggleRight && edges.stripPointer === 'none', `the header strip can take the sidebar button's hover or the header's clicks: ${JSON.stringify(edges)}`);
    assert(Math.abs(edges.header - edges.sidebar) < 1 && edges.hostBorder === '0px' && await headerLeft() === collapsedHeaderLeft,
      `the header column does not line up with the peeked sidebar, or the header moved: ${JSON.stringify({ ...edges, headerLeft: await headerLeft(), collapsedHeaderLeft })}`);
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...gap });
    assert(await peeking(), 'sidebar hid while crossing the header from its button');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gap.x, y: edge.y });
    await pause();
    assert((await measure()).sidebar > 0, 'sidebar hid while moving from its button into it');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...border });
    assert(await peeking(), 'sidebar hid on the header border while crossing back to its button');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...gap });
    assert(await peeking(), 'sidebar hid while crossing the header back to its button');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...toggle });
    await pause();
    assert((await measure()).sidebar > 0, 'sidebar hid with the pointer back on its button');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gap.x, y: edge.y });
    await settle();
    // A clicked button keeps focus without a focus ring; that must not hold the peek open once the pointer leaves.
    // The open-tasks tab is already selected, so clicking it changes nothing else.
    const heading = await evaluate("(() => { const r = document.querySelector('.workspace-sidebar #open-tasks-tab').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...heading });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...heading, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...heading, button: 'left', buttons: 0, clickCount: 1 });
    await settle();
    assert(await evaluate("document.activeElement?.matches('.workspace-sidebar #open-tasks-tab') && !document.activeElement.matches(':focus-visible')"), 'a click did not leave mouse focus on the open-tasks tab');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resized.sidebar + 100, y: edge.y });
    await settle();
    assert((await measure()).sidebar === 0, 'sidebar opened from its button did not hide after leaving, or a clicked button held it open');
    await evaluate('document.activeElement.blur()');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...toggle });
    await settle();
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toggle.x + 200, y: toggle.y });
    await pause();
    assert((await measure()).sidebar === 0, 'sidebar stayed open after the pointer left its button for the header');
  } finally { if (attachedHere) debuggerApi.detach(); }
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
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
      nativeTheme.themeSource = theme; await settle();
      writeFileSync(path.join(results, `sidebar-collapsed-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true, bubbles: true, cancelable: true }))`);
    await settle();
    assert((await measure()).sidebar === resized.sidebar - 16, 'sidebar shortcut did not restore remembered width');
    await checkHeader();
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
      nativeTheme.themeSource = theme; await settle();
      writeFileSync(path.join(results, `sidebar-expanded-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
  } finally { nativeTheme.themeSource = originalTheme; }
  await evaluate("document.querySelector('.sidebar-divider').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  await settle();
  assert((await measure()).sidebar === SIDEBAR_DEFAULT, 'sidebar reset width failed');
  report.sidebar = { initial, resized, restored: await measure() };
  report.checks.push('Collapsed sidebar reveals on left-edge hover or on hovering its header button without shifting the workspace, stays usable under the pointer, and hides on leave');
  report.checks.push('Sidebar drags and resizes by keyboard, collapses without remounting the composer, remembers its state through reload, and restores with Cmd/Ctrl+B in both themes');
  report.checks.push('Header logo and sidebar toggle fit inside their column without crossing the divider in expanded and collapsed layouts, including a narrow window');
}
