import { BrowserWindow, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runFilePreviewsSmoke({ window, project, results, evaluate, waitFor, report }) {
  const originalOpen = shell.openPath, originalReveal = shell.showItemInFolder;
  const external = [];
  shell.openPath = async target => { external.push(target); return ''; };
  shell.showItemInFolder = target => { external.push(target); };
  try {
    writeFileSync(path.join(project, 'PLAN.md'), '# Project plan\n\n- Build the preview\n- Keep files inside Jolo\n');
    writeFileSync(path.join(project, 'My Report.txt'), 'Encoded path opened correctly.');
    writeFileSync(path.join(project, 'location.js'), Array.from({ length: 150 }, (_, i) => `// Line ${i + 1}: ${'x'.repeat(120)}`).join('\n'));
    writeFileSync(path.join(project, 'archive.zip'), Buffer.from([0x50, 0x4b, 0, 3]));
    writeFileSync(path.join(project, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64'));
    const pdfWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
    try { await pdfWindow.loadURL('data:text/html,<h1>Jolo PDF preview</h1><p>This document opens inside the Files panel.</p>'); writeFileSync(path.join(project, 'report.pdf'), await pdfWindow.webContents.printToPDF({})); }
    finally { pdfWindow.destroy(); }
    const filter = value => evaluate(`(() => { const input = document.querySelector('.explorer-filter input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); // a capture shows the last painted frame
    const tabNamed = name => `[...document.querySelectorAll('.panel-item-tabs [role=tab]')].some(tab => tab.getAttribute('aria-label') === ${JSON.stringify(name)})`;
    // The Files panel opens on the project tree; a file picked there opens as a tab and can be edited and saved.
    await evaluate("document.querySelector('.header [aria-label=\"Panels\"]').click()");
    await waitFor("Boolean(document.querySelector('.panel-menu:popover-open [role=menuitemradio][aria-label=Files]'))", 'panel menu open');
    await evaluate("document.querySelector('.panel-menu:popover-open [role=menuitemradio][aria-label=Files]').click()");
    await waitFor("Boolean(document.querySelector('.files-empty')) && [...document.querySelectorAll('.explorer-row')].some(row => row.textContent === 'MDPLAN.md')", 'the tree lists the project beside the empty file area');
    await filter('locat');
    await waitFor("[...document.querySelectorAll('.explorer-matches .explorer-row')].some(row => row.textContent.includes('location.js')) && ![...document.querySelectorAll('.explorer-row')].some(row => row.textContent === 'MDPLAN.md')", 'the filter shows matches instead of the tree');
    await filter('');
    await waitFor("[...document.querySelectorAll('.explorer-row')].some(row => row.textContent === 'MDPLAN.md')", 'clearing the filter restores the tree');
    await evaluate("[...document.querySelectorAll('.explorer-row')].find(row => row.textContent === 'MDPLAN.md').click()");
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-content h3')?.textContent === 'Project plan'", 'a file picked in the tree opens as a tab');
    await evaluate("document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Edit file\"]').click()");
    // Source is a CodeMirror editor: read-only until Edit, then editable and focused; the smoke types through its view.
    await waitFor("(() => { const view = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView; return Boolean(view) && !view.state.readOnly && view.contentDOM.contentEditable === 'true' && document.activeElement === view.contentDOM && view.state.doc.toString().startsWith('# Project plan'); })()", 'the editor opens');
    await evaluate("(() => { const view = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source').cmView; view.dispatch({ changes: { from: view.state.doc.length, insert: '- Edited in Jolo\\n' }, userEvent: 'input.type' }); })()");
    await waitFor(`Boolean(document.querySelector('.panel-item-content:not([hidden]) [aria-label="Save file"]')) && ${tabNamed('PLAN.md •')}`, 'an edit marks the tab and offers Save');
    // Revert puts the saved text back, even with the editor still focused, and clears the mark; then the edit is made again.
    await evaluate("document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Revert file\"]').click()");
    await waitFor(`(() => { const view = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source').cmView; return document.activeElement === view.contentDOM && view.state.doc.toString() === ${JSON.stringify('# Project plan\n\n- Build the preview\n- Keep files inside Jolo\n')} && !document.querySelector('.panel-item-content:not([hidden]) [aria-label="Save file"]') && ${tabNamed('PLAN.md')}; })()`, 'Revert restores the saved text and clears the mark');
    await evaluate("(() => { const view = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source').cmView; view.dispatch({ changes: { from: view.state.doc.length, insert: '- Edited in Jolo\\n' }, userEvent: 'input.type' }); })()");
    await waitFor(`Boolean(document.querySelector('.panel-item-content:not([hidden]) [aria-label="Save file"]')) && ${tabNamed('PLAN.md •')}`, 'an edit marks the tab and offers Save');
    await evaluate("document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Save file\"]').click()");
    for (let tries = 0; tries < 50 && !readFileSync(path.join(project, 'PLAN.md'), 'utf8').includes('- Edited in Jolo'); tries++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!readFileSync(path.join(project, 'PLAN.md'), 'utf8').includes('- Edited in Jolo')) throw new Error('the edit was not written to disk');
    await waitFor(`${tabNamed('PLAN.md')} && !document.querySelector('.panel-item-content:not([hidden]) [aria-label="Save file"]')`, 'saving clears the mark');
    await evaluate("document.querySelector('[aria-label=\"Close PLAN.md\"]').click()");
    await waitFor(`!${tabNamed('PLAN.md')} && Boolean(document.querySelector('.files-empty'))`, 'closing the tab shows the empty file area again');
    report.checks.push('the Files panel shows the project tree beside the open file, filters it, opens a file from it, reverts an edit, and saves an edit back to disk');
    // A leading "?" searches inside the files; a line found opens its file there, under a tab that wears the file's badge.
    writeFileSync(path.join(project, 'search-target.js'), Array.from({ length: 120 }, (_, i) => i === 96 ? 'export const marker = "zephyrine";' : `// filler line ${i + 1}`).join('\n'));
    await filter('?zephyrine');
    await waitFor("Boolean(document.querySelector('.explorer-hits .explorer-hit-file[data-path=\"search-target.js\"] .file-badge')) && document.querySelector('.explorer-hits .explorer-hit[data-path=\"search-target.js:97\"] mark')?.textContent === 'zephyrine' && document.querySelectorAll('.explorer-hits .explorer-hit').length === 1", 'searching in files lists the found line under its file');
    await evaluate("document.querySelector('.explorer-hits .explorer-hit[data-path=\"search-target.js:97\"]').click()");
    await waitFor("(() => { const view = document.querySelector('.files-main .panel-item-content:not([hidden]) .file-preview-source')?.cmView; if (!view || view.state.doc.lineAt(view.state.selection.main.head).number !== 97) return false; const at = view.coordsAtPos(view.state.selection.main.head), box = view.dom.closest('.file-preview-content').getBoundingClientRect(); return Boolean(at) && at.top >= box.top && at.bottom <= box.bottom && Boolean(document.querySelector('.files-main .panel-item-content:not([hidden]) .file-source-location')?.textContent.includes('zephyrine')); })()", 'a found line opens its file with that line in view');
    await waitFor("document.querySelector('.panel-item-tabs [role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'search-target.js' && document.querySelector('.panel-item-tabs [role=tab][aria-selected=true] .file-badge')?.textContent === 'JS'", 'the file tab wears its type badge');
    await frame();
    writeFileSync(path.join(results, 'file-search.png'), (await window.webContents.capturePage()).toPNG());
    await filter('');
    // Typing in a file opened at a found line keeps the caret where it typed; the tab's new mark does not reveal the line again.
    const found = "document.querySelector('.files-main .panel-item-content:not([hidden]) .file-preview-source').cmView";
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Edit file\"]').click()");
    await waitFor(`(() => { const view = ${found}; return !view.state.readOnly && document.activeElement === view.contentDOM; })()`, 'the found file opens for editing');
    await evaluate(`(() => { const view = ${found}; view.dispatch({ changes: { from: 0, insert: '// edited\\n' }, selection: { anchor: 9 }, userEvent: 'input.type' }); })()`);
    await waitFor(tabNamed('search-target.js •'), 'an edit marks the found file');
    await frame();
    if (!await evaluate(`(() => { const view = ${found}; return view.state.doc.lineAt(view.state.selection.main.head).number === 1; })()`)) throw new Error('typing in a file opened at a found line sent the caret back to that line');
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Revert file\"]').click()");
    await waitFor(`${tabNamed('search-target.js')} && !document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label="Revert file"]')`, 'Revert leaves the found file clean');
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Stop editing\"]').click()");
    report.checks.push('"?" in the filter searches inside the files, lists each line found under its file, and opens the file with that line in view under a tab showing its type badge; typing there keeps the caret where it types');
    // Expand lets the Files panel take the whole pane; Esc, or the same button, gives the conversation its column back.
    const chatWidth = await evaluate("document.querySelector('.pane-body > .main').getBoundingClientRect().width");
    const expanded = "(() => { const body = document.querySelector('.pane-body').getBoundingClientRect(), panel = document.querySelector('.inspector').getBoundingClientRect(); return document.querySelector('.pane-workspace').classList.contains('files-expanded') && document.querySelector('.pane-body > .main').getBoundingClientRect().width === 0 && Math.abs(panel.width - body.width) < 2 && Boolean(document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Restore panel\"]')); })()";
    const restored = `!document.querySelector('.pane-workspace').classList.contains('files-expanded') && Math.abs(document.querySelector('.pane-body > .main').getBoundingClientRect().width - ${chatWidth}) < 2`;
    if (!(chatWidth > 200)) throw new Error(`the conversation column was not beside the Files panel: ${chatWidth}`);
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Expand panel\"]').click()");
    await waitFor(expanded, 'Expand gives the Files panel the whole pane');
    // The wider editor measures its lines again: line 98's number sits beside line 98, not where the wrapped line 97 left it.
    await waitFor("(() => { const view = document.querySelector('.files-main .panel-item-content:not([hidden]) .file-preview-source').cmView; const number = [...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(element => element.textContent === '98'), line = [...view.contentDOM.querySelectorAll('.cm-line')].find(element => element.textContent === '// filler line 98'); return Boolean(number && line) && Math.abs(number.getBoundingClientRect().top - line.getBoundingClientRect().top) < 2; })()", 'the expanded editor lines its numbers up again');
    await frame();
    writeFileSync(path.join(results, 'files-expanded.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("(() => { const button = document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Restore panel\"]'); button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); })()");
    await waitFor(restored, 'Esc gives the conversation its column back');
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Expand panel\"]').click()");
    await waitFor(expanded, 'Expand again');
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Restore panel\"]').click()");
    await waitFor(restored, 'the same button gives the conversation its column back');
    // The button goes with the file, so showing no file, as the Files tab does, gives the conversation back as well.
    await evaluate("document.querySelector('.files-main .panel-item-content:not([hidden]) [aria-label=\"Expand panel\"]').click()");
    await waitFor(expanded, 'Expand once more');
    await evaluate("[...document.querySelectorAll('.panel-item-tabs [role=tab]')].find(tab => tab.getAttribute('aria-label') === 'Files').click()");
    await waitFor(`${restored} && Boolean(document.querySelector('.files-empty'))`, 'showing no file gives the conversation its column back');
    report.checks.push('Expand in the file heading gives the Files panel the whole pane and hides the conversation; Esc, the same button, or showing no file restores it');
    await evaluate("window.__joloSmoke.send('Show the generated files')");
    await waitFor("Array.from(document.querySelectorAll('.message.assistant a')).some(a => a.textContent === 'PLAN.md')", 'assistant file links');
    const click = async name => evaluate(`Array.from(document.querySelectorAll('.message.assistant a')).find(a => a.textContent === ${JSON.stringify(name)}).click()`);
    await click('PLAN.md');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-content h3')?.textContent === 'Project plan'", 'Markdown rendered in Files');
    await evaluate("Array.from(document.querySelectorAll('.file-heading [role=tab]')).find(b=>b.textContent==='Source').click()");
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView?.state.doc.toString()?.includes('# Project plan')", 'Markdown source toggle');
    await click('app.js');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView?.state.doc.toString()?.includes('export const answer = 42') && Boolean(document.querySelector('.panel-item-content:not([hidden]) .file-preview-source .cm-line span[class]'))", 'code opens internally, with syntax colours');
    await click('location.js');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-source-location')?.textContent.startsWith('// Line 120:')", 'source location highlighted');
    const revealed = "(() => { const editor = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView; if (!editor) return false; const head = editor.state.selection.main.head, line = editor.state.doc.lineAt(head); if (line.number !== 120 || head - line.from !== 81) return false; const target = editor.coordsAtPos(head); const view = editor.dom.closest('.file-preview-content').getBoundingClientRect(); return Boolean(target) && target.top >= view.top && target.bottom <= view.bottom && target.left >= view.left && target.right <= view.right; })()";
    await waitFor(revealed, 'line and column scrolled into view');
    await waitFor("Boolean(document.querySelector('.panel-item-content:not([hidden]) .file-source-location span[class]'))", 'the revealed line has syntax colours');
    writeFileSync(path.join(results, 'file-preview-source.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("(() => { const editor = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source').cmView; editor.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); })()");
    await waitFor("(() => { const editor = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source').cmView; const target = editor.coordsAtPos(editor.state.doc.line(120).from); return editor.state.selection.main.head === 0 && (!target || target.top > editor.dom.closest('.file-preview-content').getBoundingClientRect().bottom); })()", 'the reader scrolls away from the location');
    await click('location.js');
    await waitFor(revealed, 'following the same link again scrolls back to the location');
    await click('My report');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView?.state.doc.toString() === 'Encoded path opened correctly.'", 'encoded Markdown path decoded once');
    if (await evaluate("Array.from(document.querySelectorAll('.message.assistant a')).some(a => ['/install.sh', 'releases/latest.txt', 'desktop.json'].includes(a.textContent))")) throw new Error('Ambiguous website assets became local file links');
    const messageHeight = await evaluate("Array.from(document.querySelectorAll('.message.assistant')).find(m => m.textContent.includes('missing.js')).getBoundingClientRect().height");
    await click('missing.js');
    await waitFor("document.querySelector('.file-link-notice:popover-open')?.textContent.includes('File not found: missing.js')", 'dismissible missing file notice');
    if (await evaluate("Boolean(document.querySelector('.message .file-link-notice'))")) throw new Error('File errors were inserted into the message');
    if (await evaluate("Array.from(document.querySelectorAll('.message.assistant')).find(m => m.textContent.includes('missing.js')).getBoundingClientRect().height") !== messageHeight) throw new Error('File error changed the report layout');
    writeFileSync(path.join(results, 'file-link-notice.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[aria-label=\"Dismiss file error\"]').click()");
    await waitFor("!document.querySelector('.file-link-notice')", 'file notice dismissed');
    await click('image.png');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-content img')?.naturalWidth === 1", 'image loads through the private preview URL');
    await click('report.pdf');
    await waitFor("Boolean(document.querySelector('.panel-item-content:not([hidden]) .file-preview-content embed'))", 'PDF viewer opens');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const pdfFrame = window.webContents.mainFrame.framesInSubtree.find(frame => frame.url === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html');
    if (!pdfFrame || !await pdfFrame.executeJavaScript("Boolean(document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('viewer-toolbar:not([loading_])'))")) throw new Error('PDF document did not finish loading');
    writeFileSync(path.join(results, 'file-preview-pdf.png'), (await window.webContents.capturePage()).toPNG());
    await click('archive.zip');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-content')?.textContent.includes('A visual preview is not available')", 'unknown binary remains inside Jolo');
    await click('PLAN.md');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView?.state.doc.toString()?.includes('# Project plan')", 'Markdown source view retained');
    writeFileSync(path.join(results, 'file-preview-markdown.png'), (await window.webContents.capturePage()).toPNG());
    if (external.length) throw new Error(`File links escaped Jolo: ${external.join(', ')}`);
    const fixture = new BrowserWindow({ show: false, width: 1200, height: 1100, webPreferences: { sandbox: true, nodeIntegration: false } });
    try {
      await fixture.loadURL('data:text/html,<title>File link regression checks</title>');
      await fixture.webContents.insertCSS(readFileSync(new URL('../dist/styles.css', import.meta.url), 'utf8'));
      await fixture.webContents.executeJavaScript(readFileSync(process.env.JOLO_FILE_LINKS_FIXTURE, 'utf8'));
      const deadline = Date.now() + 10_000;
      let result;
      while (!(result = await fixture.webContents.executeJavaScript('window.fileLinkResult'))) {
        if (Date.now() > deadline) throw new Error('File link renderer checks timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!result.ok) throw new Error(result.error);
      report.checks.push(...result.checks);
      writeFileSync(path.join(results, 'markdown-review-table.png'), (await fixture.webContents.capturePage()).toPNG());
    } finally { fixture.destroy(); }
    report.checks.push('Markdown, source code, images, PDFs, and unknown file formats open in Jolo without invoking external apps; explicit file links resolve nested files, source locations scroll into view, website assets remain text, and dismissible errors leave report layout intact');
  } finally { shell.openPath = originalOpen; shell.showItemInFolder = originalReveal; }
}
