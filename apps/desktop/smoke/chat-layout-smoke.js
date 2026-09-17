import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runChatLayoutSmoke({ results, report }) {
  const fixture = new BrowserWindow({ width: 1240, height: 1000, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    await fixture.loadURL('data:text/html,<title>Chat layout regression checks</title>');
    fixture.moveTop();
    fixture.focus();
    app.focus({ steal: true });
    await fixture.webContents.insertCSS(readFileSync(new URL('../dist/styles.css', import.meta.url), 'utf8'));
    await fixture.webContents.executeJavaScript(readFileSync(process.env.JOLO_CHAT_LAYOUT_FIXTURE, 'utf8'));
    const deadline = Date.now() + 15_000;
    let result;
    while (!(result = await fixture.webContents.executeJavaScript('window.chatLayoutResult'))) {
      if (Date.now() > deadline) throw new Error('Chat layout regression checks timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!result.ok) throw new Error(result.error);
    report.checks.push(...result.checks);
    writeFileSync(path.join(results, 'sequence-layout.png'), (await fixture.webContents.capturePage()).toPNG());
    await fixture.webContents.executeJavaScript(`document.querySelector('[aria-label="Open full-window diagram"]').click()`);
    await fixture.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    writeFileSync(path.join(results, 'sequence-full-window.png'), (await fixture.webContents.capturePage()).toPNG());
    await fixture.webContents.executeJavaScript(`document.querySelector('[aria-label="Close diagram"]').click(); window.showCopyFixture()`);
    await fixture.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    writeFileSync(path.join(results, 'code-copy.png'), (await fixture.webContents.capturePage()).toPNG());
    writeFileSync(path.join(results, 'chat-layout-smoke.json'), JSON.stringify(report, null, 2));
  } finally { fixture.destroy(); }
}
