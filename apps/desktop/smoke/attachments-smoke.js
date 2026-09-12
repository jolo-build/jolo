import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Exercise the native paste event through the real composer, bridge, engine and agent fixture. */
export async function runAttachmentsSmoke({ window, bridge, evaluate, waitFor, results, report }) {
  await evaluate("window.__joloSmoke.showTask()");
  await evaluate("window.__joloSmoke.selectSession(null)");
  await evaluate("window.__joloSmoke.pickAnswerer('claude')");
  await waitFor("window.__joloSmoke.state().answerer === 'Claude Code'", 'image answerer');
  await evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'image-check');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'ordinary text');
    const paste = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    if (paste.defaultPrevented) throw new Error('ordinary text paste was intercepted');
  })()`);
  const png = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#253447'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#f8fafc'; ctx.font = '22px sans-serif'; ctx.fillText('Pasted screenshot', 22, 45);
    ctx.fillStyle = '#5bb4ca'; ctx.fillRect(22, 70, 170, 16); ctx.fillRect(22, 98, 270, 16); ctx.fillRect(22, 126, 215, 16);
    return canvas.toDataURL('image/png');
  })()`);
  const pasteImages = (count, type = 'image/png') => evaluate(`(() => {
    const data = Uint8Array.from(atob(${JSON.stringify(png.split(',')[1])}), c => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    for (let n = 0; n < ${count}; n++) clipboard.items.add(new File([data], 'Screenshot-' + n + '.png', { type: ${JSON.stringify(type)} }));
    document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  })()`);
  await pasteImages(2);
  await waitFor("document.querySelectorAll('.composer-attachment img').length === 2 && !document.querySelector('.attachment-note[role=status]')", 'two pasted images');
  await evaluate("document.querySelector('.composer-attachment button').click()");
  await waitFor("document.querySelectorAll('.composer-attachment img').length === 1", 'remove attachment');
  const call = bridge.call;
  let uploadSessionId;
  bridge.call = function(method, params) {
    if (method === 'attachment.write') {
      uploadSessionId = params.sessionId;
      return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Image upload interrupted for retry check' } });
    }
    return call.call(this, method, params);
  };
  try {
    await evaluate("document.querySelector('.composer button[type=submit]').click()");
    await waitFor("document.body.textContent.includes('Image upload interrupted for retry check')", 'upload failure');
    if (!(await evaluate("document.querySelector('.composer textarea').value === 'image-check' && document.querySelectorAll('.composer-attachment').length === 1"))) throw new Error('failed first send lost its text or image');
  } finally { bridge.call = call; }
  writeFileSync(path.join(results, 'image-paste-draft.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('.composer button[type=submit]').click()");
  await waitFor("window.__joloSmoke.state().runState === 'completed' && document.querySelector('.message.assistant')?.textContent.includes('Images received: image/png:')", 'image delivered to Claude');
  await waitFor("document.querySelector('.message-attachment img')?.naturalWidth === 320", 'sent image preview');
  if (await evaluate("document.querySelectorAll('.composer-attachment').length")) throw new Error('sent image remained attached to the next draft');
  const sessionId = await evaluate('window.__joloSmoke.state().sessionId');
  if (sessionId !== uploadSessionId) throw new Error('retry created another task instead of reusing the draft task');
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(sessionId)})`);
  await waitFor("document.querySelector('.message-attachment img')?.naturalWidth === 320", 'saved attachment after reopening');
  writeFileSync(path.join(results, 'image-paste-sent.png'), (await window.webContents.capturePage()).toPNG());

  // An image-only message can be queued; other image formats attach as ordinary files.
  await evaluate("window.__joloSmoke.newTask()");
  await evaluate("window.__joloSmoke.pickAnswerer('grok')");
  await waitFor("window.__joloSmoke.state().answerer === 'Grok CLI'", 'queue image answerer');
  const running = await evaluate("window.__joloSmoke.send('sleep for image queue')");
  await waitFor("Boolean(document.querySelector('.composer [aria-label=\"Stop task\"]'))", 'image queue running');
  await pasteImages(1, 'image/svg+xml');
  await waitFor("document.querySelector('.composer-attachment.text-file') && !document.querySelector('.attachment-note[role=status]')", 'other image format attached as file');
  await evaluate("document.querySelector('.composer-attachment > button').click()");
  await pasteImages(1);
  await waitFor("document.querySelector('.composer button[type=submit]') && !document.querySelector('.composer button[type=submit]').disabled", 'image-only queue enabled');
  await evaluate("document.querySelector('.composer button[type=submit]').click()");
  await waitFor("document.querySelector('.message-queue')?.textContent.includes('1 image')", 'image-only message queued');
  await evaluate("document.querySelector('.message-queue [aria-label=\"Remove queued message\"]').click()");
  await bridge.rawCall('run.cancel', { runId: running.id });
  report.checks.push('image paste previews and removal, first-send failure retains the draft, retry delivers pixels to Claude, sent images survive reopening, image-only queueing, and other formats attach as files');

  await evaluate("window.__joloSmoke.newTask()");
  await evaluate("window.__joloSmoke.pickAnswerer('claude')");
  await waitFor("window.__joloSmoke.state().answerer === 'Claude Code'", 'text attachment answerer');
  await evaluate(`(() => {
    window.__pastedLog = 'Crash log 🙂漢字: the full line must survive.\\n'.repeat(1800) + 'PASTED_LOG_END';
    const input = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Review this log');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const pasteText = () => evaluate(`(() => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', window.__pastedLog);
    const paste = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
    document.querySelector('.composer textarea').dispatchEvent(paste);
    if (!paste.defaultPrevented) throw new Error('long text was inserted inline');
  })()`);
  await pasteText();
  await waitFor("document.querySelector('.composer-attachment.text-file .text-attachment-card') && !document.querySelector('.attachment-note[role=status]')", 'pasted text card');
  if (!(await evaluate("document.querySelector('.composer textarea').value === 'Review this log'"))) throw new Error('long paste changed the existing prompt');
  await evaluate("document.querySelector('.composer-attachment .text-attachment-card').click()");
  await waitFor("document.querySelector('.text-attachment-preview pre')?.textContent === window.__pastedLog", 'complete draft text preview');
  await evaluate("document.querySelector('[aria-label=\"Close text preview\"]').click()");
  await evaluate("document.querySelector('.composer-attachment > button:not(.text-attachment-card)').click()");
  await waitFor("!document.querySelector('.composer-attachment.text-file')", 'remove pasted text');
  await pasteText();
  await waitFor("document.querySelector('.composer-attachment.text-file') && !document.querySelector('.attachment-note[role=status]')", 'paste text again');
  writeFileSync(path.join(results, 'text-paste-draft.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('.composer button[type=submit]').click()");
  await waitFor("window.__joloSmoke.state().runState === 'completed' && document.querySelector('.message.user .text-attachment-card')", 'text attachment sent');
  if (!(await evaluate("document.querySelector('.message.user').textContent.includes('Review this log') && !document.querySelector('.message.user').textContent.includes('PASTED_LOG_END') && !document.querySelector('.composer-attachment')"))) throw new Error('sent text was expanded inline or retained in the draft');
  const textSessionId = await evaluate('window.__joloSmoke.state().sessionId');
  await evaluate("window.__joloSmoke.newTask()");
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(textSessionId)})`);
  await waitFor("document.querySelector('.message.user .text-attachment-card')", 'saved text attachment after reopening');
  await evaluate("document.querySelector('.message.user .text-attachment-card').click()");
  await waitFor("document.querySelector('.text-attachment-preview pre')?.textContent === window.__pastedLog", 'full uploaded UTF-8 text preview');
  writeFileSync(path.join(results, 'text-paste-preview.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('[aria-label=\"Close text preview\"]').click()");
  report.checks.push('long text paste becomes a removable compact file, preserves the prompt, previews all Unicode text, sends successfully, and survives reopening');
  await evaluate("window.__joloSmoke.newTask()");
  await evaluate("window.__joloSmoke.pickAnswerer('codex')");
  await waitFor("window.__joloSmoke.state().answerer === 'Codex'", 'file answerer');
  await evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'file-check');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const files = new DataTransfer();
    files.items.add(new File(['%PDF-test'], 'Report.pdf', { type: 'application/pdf' }));
    const picker = document.querySelector('.composer input[type=file]');
    picker.files = files.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor("document.querySelector('.composer-attachment')?.textContent.includes('Report.pdf') && !document.querySelector('.attachment-note[role=status]')", 'PDF chosen in file input');
  await evaluate(`(() => {
    const files = new DataTransfer();
    files.items.add(new File(['export const ready = true;'], 'example.ts', { type: 'text/plain' }));
    document.querySelector('.composer').dispatchEvent(new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true }));
  })()`);
  await waitFor("document.querySelectorAll('.composer-attachment').length === 2 && !document.querySelector('.attachment-note[role=status]')", 'source file dropped alongside PDF');
  await evaluate("document.querySelector('.composer button[type=submit]').click()");
  await waitFor("window.__joloSmoke.state().runState === 'completed' && document.querySelector('.message.assistant')?.textContent.includes('File received: 255044462d74657374')", 'Codex opens uploaded PDF bytes');
  if (!(await evaluate("document.querySelector('.message.user').textContent.includes('Report.pdf') && document.querySelector('.message.user').textContent.includes('example.ts') && !document.querySelector('.composer-attachment')"))) throw new Error('File cards missing or draft not cleared');
  writeFileSync(path.join(results, 'files-sent.png'), (await window.webContents.capturePage()).toPNG());
  report.checks.push('file input accepts PDF, drag-and-drop accepts source files, Codex opens uploaded bytes, and sent file cards persist');

  const fileSessionId = await evaluate('window.__joloSmoke.state().sessionId');
  await waitFor(`Boolean(document.querySelector('.task-rail [data-task-id="${textSessionId}"]'))`, 'task rail lists another chat');
  await evaluate(`document.querySelector('.task-rail [data-task-id="${textSessionId}"]').click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(textSessionId)}`, 'task rail switches chats');
  await waitFor(`Boolean(document.querySelector('.task-rail [data-task-id="${textSessionId}"][aria-current="page"]'))`, 'task rail highlights selection');
  await evaluate(`document.querySelector('.task-rail [data-task-id="${fileSessionId}"]').click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(fileSessionId)}`, 'task rail returns to previous chat');
  await waitFor("document.querySelector('.message.user')?.textContent.includes('Report.pdf')", 'task rail loads the selected conversation');
  writeFileSync(path.join(results, 'task-rail.png'), (await window.webContents.capturePage()).toPNG());
  report.checks.push('task rail switches between saved chats and highlights the active chat');

}
