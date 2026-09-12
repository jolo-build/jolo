import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openChatFile, previewChatFile } from '../src/main/chat-files.js';
import { createFilePreviewStore } from '../src/main/file-preview-store.js';
import { parseInline } from '@jolo/markdown';

test('preserves local Markdown destinations and rejects executable URL schemes', () => {
  expect(parseInline('[Download](report.pdf)')[0]).toMatchObject({ type: 'link', local: true, href: 'report.pdf' });
  expect(parseInline('[Download](sandbox:/tmp/report.pdf)')[0]).toMatchObject({ local: true, href: '/tmp/report.pdf' });
  expect(parseInline('[bad](javascript:report.pdf)')[0].type).toBe('text');
  expect(parseInline('[Dockerfile](Dockerfile)')[0]).toMatchObject({ local: true, href: 'Dockerfile' });
  expect(parseInline('[config](.env)')[0]).toMatchObject({ local: true, href: '.env' });
});
test('opens actual documents, reveals source files, and reports missing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-chat-file-'));
  try {
    await writeFile(path.join(root, 'report.pdf'), '%PDF-1.7');
    await writeFile(path.join(root, 'script.py'), 'print(1)');
    await symlink(path.join(root, 'script.py'), path.join(root, 'fake.pdf'));
    const opened = [], revealed = [];
    const shell = { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file) };
    const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }] };
    await openChatFile(call, shell, { sessionId: 's', path: 'report.pdf' });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toEndWith('/report.pdf');
    await openChatFile(call, shell, { sessionId: 's', path: 'script.py:4' });
    await openChatFile(call, shell, { sessionId: 's', path: 'fake.pdf' });
    expect(revealed).toHaveLength(2);
    expect(opened).toHaveLength(1);
    await expect(openChatFile(call, shell, { sessionId: 's', path: 'missing.pdf' })).rejects.toThrow('File not found');
    await expect(openChatFile(call, shell, { sessionId: 's', path: 'javascript:report.pdf' })).rejects.toThrow('supported file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a named PDF link renders one clickable anchor, not nested filename links', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  const html = renderToStaticMarkup(createElement(Markdown, { text: '[Download report.pdf](/tmp/report.pdf)', cacheKey: 'file', sessionId: 's' }));
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('Open /tmp/report.pdf');
});

test('file previews read Markdown and code, serve media privately, and keep unknown binaries internal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-file-preview-'));
  const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }] };
  try {
    await writeFile(path.join(root, 'PLAN.md'), '# The plan\n');
    await writeFile(path.join(root, 'app.js'), 'export const ready = true;');
    await writeFile(path.join(root, 'Dockerfile'), 'FROM scratch');
    await writeFile(path.join(root, 'archive.zip'), Buffer.from([0x50, 0x4b, 0, 3]));
    await writeFile(path.join(root, 'report.pdf'), '%PDF-1.7\nfixture');
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(300 * 1024));
    expect(await previewChatFile(call, { sessionId: 's', path: 'PLAN.md:1' })).toMatchObject({ kind: 'markdown', text: '# The plan\n', truncated: false });
    expect(await previewChatFile(call, { sessionId: 's', path: path.join(root, 'app.js') })).toMatchObject({ kind: 'text', text: 'export const ready = true;' });
    expect(await previewChatFile(call, { sessionId: 's', path: 'Dockerfile' })).toMatchObject({ kind: 'text', text: 'FROM scratch' });
    expect(await previewChatFile(call, { sessionId: 's', path: 'archive.zip' })).toMatchObject({ kind: 'details', size: 4 });
    expect(await previewChatFile(call, { sessionId: 's', path: 'large.txt' })).toMatchObject({ kind: 'text', truncated: true });
    const store = createFilePreviewStore(call);
    const pdf = await store.prepare({ sessionId: 's', path: 'report.pdf' });
    expect(pdf.kind).toBe('pdf');
    expect('content' in pdf).toBe(false);
    const url = /** @type {any} */ (pdf).url;
    expect(await store.response(new Request(url)).text()).toBe('%PDF-1.7\nfixture');
    const range = store.response(new Request(url, { headers: { range: 'bytes=0-3' } }));
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('%PDF');
    const viewer = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
    const navigation = { isMainFrame: false, url: `${viewer}stream`, initiator: { url: `${viewer}index.html` }, frame: { parent: { url } } };
    expect(store.allowsFrameNavigation(navigation)).toBe(true);
    expect(store.allowsFrameNavigation({ ...navigation, isMainFrame: true })).toBe(false);
    expect(store.allowsFrameNavigation({ ...navigation, initiator: { url: 'https://example.com' } })).toBe(false);
    expect(store.allowsFrameNavigation({ ...navigation, frame: { parent: { url: 'https://example.com' } } })).toBe(false);
    store.release(url);
    expect(store.allowsFrameNavigation(navigation)).toBe(false);
    expect(store.response(new Request(url)).status).toBe(404);
    expect(store.response(new Request('jolo-file-preview://preview/PLAN.md')).status).toBe(404);
  } finally { await rm(root, { recursive: true, force: true }); }
});
