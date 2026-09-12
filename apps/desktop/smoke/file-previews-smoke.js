import { BrowserWindow, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runFilePreviewsSmoke({ window, project, results, evaluate, waitFor, report }) {
  const originalOpen = shell.openPath, originalReveal = shell.showItemInFolder;
  const external = [];
  shell.openPath = async target => { external.push(target); return ''; };
  shell.showItemInFolder = target => { external.push(target); };
  try {
    writeFileSync(path.join(project, 'PLAN.md'), '# Project plan\n\n- Build the preview\n- Keep files inside Jolo\n');
    writeFileSync(path.join(project, 'archive.zip'), Buffer.from([0x50, 0x4b, 0, 3]));
    writeFileSync(path.join(project, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64'));
    const pdfWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
    try { await pdfWindow.loadURL('data:text/html,<h1>Jolo PDF preview</h1><p>This document opens inside the Files panel.</p>'); writeFileSync(path.join(project, 'report.pdf'), await pdfWindow.webContents.printToPDF({})); }
    finally { pdfWindow.destroy(); }
    await evaluate("window.__joloSmoke.showTask(); window.__joloSmoke.send('Show the generated files')");
    await waitFor("Array.from(document.querySelectorAll('.message.assistant a')).some(a => a.textContent === 'PLAN.md')", 'assistant file links');
    const click = async name => evaluate(`Array.from(document.querySelectorAll('.message.assistant a')).find(a => a.textContent === ${JSON.stringify(name)}).click()`);
    await click('PLAN.md');
    await waitFor("document.querySelector('.file-preview-content h3')?.textContent === 'Project plan'", 'Markdown rendered in Files');
    await evaluate("Array.from(document.querySelectorAll('.file-heading [role=tab]')).find(b=>b.textContent==='Source').click()");
    await waitFor("document.querySelector('.file-preview-source')?.textContent.includes('# Project plan')", 'Markdown source toggle');
    await click('app.js');
    await waitFor("document.querySelector('.file-preview-source')?.textContent.includes('export const answer = 42')", 'code opens internally');
    await click('image.png');
    await waitFor("document.querySelector('.file-preview-content img')?.naturalWidth === 1", 'image loads through the private preview URL');
    await click('report.pdf');
    await waitFor("Boolean(document.querySelector('.file-preview-content embed'))", 'PDF viewer opens');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const pdfFrame = window.webContents.mainFrame.framesInSubtree.find(frame => frame.url === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html');
    if (!pdfFrame || !await pdfFrame.executeJavaScript("Boolean(document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('viewer-toolbar:not([loading_])'))")) throw new Error('PDF document did not finish loading');
    writeFileSync(path.join(results, 'file-preview-pdf.png'), (await window.webContents.capturePage()).toPNG());
    await click('archive.zip');
    await waitFor("document.querySelector('.file-preview-content')?.textContent.includes('A visual preview is not available')", 'unknown binary remains inside Jolo');
    await click('PLAN.md');
    await waitFor("document.querySelector('.file-preview-content h3')?.textContent === 'Project plan'", 'Markdown reopens');
    writeFileSync(path.join(results, 'file-preview-markdown.png'), (await window.webContents.capturePage()).toPNG());
    if (external.length) throw new Error(`File links escaped Jolo: ${external.join(', ')}`);
    report.checks.push('Markdown, source code, images, PDFs, and unknown file formats open in Jolo without invoking external apps');
  } finally { shell.openPath = originalOpen; shell.showItemInFolder = originalReveal; }
}
