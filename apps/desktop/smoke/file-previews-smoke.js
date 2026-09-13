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
    await evaluate("window.__joloSmoke.showTask(); window.__joloSmoke.send('Show the generated files')");
    await waitFor("Array.from(document.querySelectorAll('.message.assistant a')).some(a => a.textContent === 'PLAN.md')", 'assistant file links');
    const click = async name => evaluate(`Array.from(document.querySelectorAll('.message.assistant a')).find(a => a.textContent === ${JSON.stringify(name)}).click()`);
    await click('PLAN.md');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-content h3')?.textContent === 'Project plan'", 'Markdown rendered in Files');
    await evaluate("Array.from(document.querySelectorAll('.file-heading [role=tab]')).find(b=>b.textContent==='Source').click()");
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.textContent.includes('# Project plan')", 'Markdown source toggle');
    await click('app.js');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.textContent.includes('export const answer = 42')", 'code opens internally');
    await click('location.js');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-source-location')?.textContent.startsWith('// Line 120:')", 'source location highlighted');
    await waitFor("(() => { const node = document.querySelector('.panel-item-content:not([hidden]) .file-source-caret'); if (!node) return false; const target = node.getBoundingClientRect(); const view = node.closest('.file-preview-content').getBoundingClientRect(); return target.top >= view.top && target.bottom <= view.bottom && target.left >= view.left && target.right <= view.right; })()", 'line and column scrolled into view');
    await click('My report');
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.textContent === 'Encoded path opened correctly.'", 'encoded Markdown path decoded once');
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
    await waitFor("document.querySelector('.panel-item-content:not([hidden]) .file-preview-source')?.textContent.includes('# Project plan')", 'Markdown source view retained');
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
