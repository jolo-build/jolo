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
    // The Files panel opens on the project tree; a file picked there opens as a tab and can be edited and saved.
    await evaluate("document.querySelector('.header [aria-label=\"Panels\"]').click()");
    await waitFor("Boolean(document.querySelector('.panel-menu:popover-open [role=menuitemradio][aria-label=Files]'))", 'panel menu open');
    await evaluate("document.querySelector('.panel-menu:popover-open [role=menuitemradio][aria-label=Files]').click()");
    await waitFor("Boolean(document.querySelector('.files-empty')) && [...document.querySelectorAll('.explorer-row')].some(row => row.textContent === 'MDPLAN.md')", 'the tree lists the project beside the empty file area');
    await evaluate("(() => { const input = document.querySelector('.explorer-filter input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'locat'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("[...document.querySelectorAll('.explorer-matches .explorer-row')].some(row => row.textContent.includes('location.js')) && ![...document.querySelectorAll('.explorer-row')].some(row => row.textContent === 'MDPLAN.md')", 'the filter shows matches instead of the tree');
    await evaluate("(() => { const input = document.querySelector('.explorer-filter input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("[...document.querySelectorAll('.explorer-row')].some(row => row.textContent === 'MDPLAN.md')", 'clearing the filter restores the tree');
    await evaluate("[...document.querySelectorAll('.explorer-row')].find(row => row.textContent === 'MDPLAN.md').click()");
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-content h3')?.textContent === 'Project plan'", 'a file picked in the tree opens as a tab');
    await evaluate("document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Edit file\"]').click()");
    // Source is a CodeMirror editor: read-only until Edit, then editable and focused; the smoke types through its view.
    await waitFor("(() => { const view = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.cmView; return Boolean(view) && !view.state.readOnly && view.contentDOM.contentEditable === 'true' && document.activeElement === view.contentDOM && view.state.doc.toString().startsWith('# Project plan'); })()", 'the editor opens');
    await evaluate("(() => { const view = document.querySelector('.panel-item-content:not([hidden]) .file-preview-source').cmView; view.dispatch({ changes: { from: view.state.doc.length, insert: '- Edited in Jolo\\n' }, userEvent: 'input.type' }); })()");
    await waitFor("Boolean(document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Save file\"]')) && [...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent === 'PLAN.md •')", 'an edit marks the tab and offers Save');
    await evaluate("document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Save file\"]').click()");
    for (let tries = 0; tries < 50 && !readFileSync(path.join(project, 'PLAN.md'), 'utf8').includes('- Edited in Jolo'); tries++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!readFileSync(path.join(project, 'PLAN.md'), 'utf8').includes('- Edited in Jolo')) throw new Error('the edit was not written to disk');
    await waitFor("[...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent === 'PLAN.md') && !document.querySelector('.panel-item-content:not([hidden]) [aria-label=\"Save file\"]')", 'saving clears the mark');
    await evaluate("document.querySelector('[aria-label=\"Close PLAN.md\"]').click()");
    await waitFor("![...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent === 'PLAN.md') && Boolean(document.querySelector('.files-empty'))", 'closing the tab shows the empty file area again');
    report.checks.push('the Files panel shows the project tree beside the open file, filters it, opens a file from it, and saves an edit back to disk');
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
