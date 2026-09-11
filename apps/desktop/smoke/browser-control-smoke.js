// Real Chromium check for the host's input implementation. No vendor or external site is used.
import { app, BrowserWindow, nativeImage } from 'electron';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createBrowserAgent } from '../src/main/browser-agent.js';
import { FRAME_MAX_BYTES } from '@jolo/protocol';

const fixture = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Browser controls ${request.url}</title>
    <style>body{font:16px sans-serif;padding:24px;background:white}label{display:block;margin:16px 0}#hover:hover + #tip{display:block}#tip{display:none}#scroll{height:120px;width:300px;overflow:auto;border:1px solid}#scroll div{height:900px}</style>
    <h1>Browser controls</h1><form onsubmit="event.preventDefault();window.submitted=(window.submitted||0)+1">
    <label>Name <input aria-label="Name" value="old"></label><button>Save</button></form>
    <label>Color <select aria-label="Color" onchange="window.changed=this.value"><option value="red">Red</option><option value="blue">Blue</option></select></label>
    <label><input type="checkbox">Agree</label><button id="hover">Hover me</button><p id="tip">Tooltip</p>
    <div id="scroll" role="region" aria-label="Scrollable"><div>Scroll content</div></div>`);
});

app.whenReady().then(async () => {
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
const guest = window.webContents;
guest.debugger.attach('1.3');
const replies = new Map();
let sequence = 0;
const agent = createBrowserAgent({ nativeImage, log: { info() {}, warn(...args) { console.error(...args); } }, isOverlayActive: () => false,
  bridge: { async rawCall(method, params) { if (method === 'browser.result') replies.set(params.invocationId, params); return { capabilityId: 'cap_smoke' }; } } });
const host = agent.attach(guest, 'ws_smoke');
const execute = async (operation, args = {}) => {
  const invocationId = `smoke_${++sequence}`;
  await agent.handleExecute({ invocationId, capabilityId: host.capabilityId, navigationRevision: host.navigationRevision, operation, arguments: args, leaseMs: 10_000 });
  const reply = replies.get(invocationId); replies.delete(invocationId);
  assert.equal(reply?.status, 'ok', `${operation}: ${JSON.stringify(reply?.error)}`);
  return reply;
};
const inspect = script => guest.executeJavaScript(script);
const timer = setTimeout(() => { console.error('browser controls smoke timed out'); app.exit(1); }, 40_000);
try {
  await execute('navigate', { url: `${url}/form` });
  const snapshot = (await execute('snapshot')).result;
  const target = name => { const node = snapshot.nodes.find(node => node.name === name); assert.ok(node, `missing ${name}`); return { ref: node.ref, snapshotId: snapshot.snapshotId }; };
  await execute('fill', { ...target('Name'), text: 'Ada' });
  await execute('type', { ...target('Name'), text: ' Lovelace' });
  assert.equal(await inspect("document.querySelector('input').value"), 'Ada Lovelace');
  await execute('fill', { ...target('Name'), text: '' });
  assert.equal(await inspect("document.querySelector('input').value"), '');
  await execute('type', { ...target('Name'), text: 'Jolo' });
  await execute('press', { ...target('Name'), key: 'Enter' });
  assert.equal(await inspect('window.submitted'), 1);
  await execute('select', { ...target('Color'), values: ['blue'] });
  assert.equal(await inspect('window.changed'), 'blue');
  await execute('click', target('Agree'));
  assert.equal(await inspect("document.querySelector('[type=checkbox]').checked"), true);
  await execute('hover', target('Hover me'));
  assert.equal(await inspect("getComputedStyle(document.querySelector('#tip')).display"), 'block');
  await execute('scroll', { ...target('Scrollable'), deltaY: 400 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(await inspect("document.querySelector('#scroll').scrollTop > 0"));
  const image = (await execute('screenshot')).screenshot;
  assert.ok(image.width > 0 && image.height > 0 && Buffer.from(image.base64, 'base64').length <= 1024 * 1024);
  // High-entropy pixels exercise the encoded wire limit, not just a tiny page image.
  await inspect(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight;
    canvas.style = 'position:fixed;inset:0;z-index:999'; document.body.append(canvas);
    const ctx = canvas.getContext('2d'); const data = ctx.createImageData(canvas.width, canvas.height);
    let seed = 1;
    for (let i = 0; i < data.data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data.data[i] = i % 4 === 3 ? 255 : seed >>> 24; }
    ctx.putImageData(data, 0, 0);
  })()`);
  const noisy = await execute('screenshot');
  assert.ok(Buffer.byteLength(JSON.stringify(noisy)) < FRAME_MAX_BYTES);
  assert.ok(noisy.screenshot.width < image.width);
  await execute('navigate', { url: `${url}/second` });
  await execute('history', { action: 'back' }); assert.equal(guest.getURL(), `${url}/form`);
  await execute('history', { action: 'forward' }); assert.equal(guest.getURL(), `${url}/second`);
  await execute('history', { action: 'reload' }); assert.equal(guest.getURL(), `${url}/second`);
  console.log('Browser controls passed: snapshot, fill/clear/type, Enter, select/change, click, hover, nested scroll, screenshot, back/forward/reload.');
  clearTimeout(timer); window.destroy(); fixture.close(); app.exit(0);
} catch (error) { console.error(error); clearTimeout(timer); window.destroy(); fixture.close(); app.exit(1); }

}).catch(error => { console.error(error); app.exit(1); });
