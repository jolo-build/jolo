import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openChatFile, previewChatFile } from '../src/main/chat-files.js';
import { createFilePreviewStore } from '../src/main/file-preview-store.js';
import { parseInline } from '@jolo/markdown';
import { fileReference, webReference } from '@jolo/markdown/file-links';

test('bare web addresses are not file references, while explicit paths remain files', () => {
  for (const target of ['signals.cypho.io', 'cypho.io', 'example.com/docs/PLAN.md', 'signals.cypho.io:8443', 'www.example.com', 'example.ai', 'localhost:3000']) {
    expect(webReference(target)).toMatch(/^https?:\/\//);
    expect(fileReference(target)).toBeNull();
    expect(fileReference(target, { explicit: true })).toBeNull();
    expect(parseInline(`[Website](${target})`)[0]).toMatchObject({ type: 'link', href: webReference(target) });
    expect(parseInline(`[Website](${target})`)[0].local).not.toBe(true);
  }
  for (const target of ['PLAN.md', 'app.js', 'main.go', 'schema.db', 'archive.gz', 'src/app.ts', './signals.cypho.io', '/tmp/signals.cypho.io']) {
    expect(webReference(target)).toBeNull();
    expect(fileReference(target)).toBe(target);
  }
  expect(fileReference('file:///tmp/signals.cypho.io')).toBe('/tmp/signals.cypho.io');
  for (const target of ['javascript:alert(1)', 'data:text/html,test', 'user@example.com', 'src/test.py', 'https://']) expect(webReference(target)).toBeNull();
});

test('a domain in inline code renders as a website without the file-preview action', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  const html = renderToStaticMarkup(createElement(Markdown, { text: 'Configuration for `signals.cypho.io` and `PLAN.md`.', cacheKey: 'domain', sessionId: 's' }));
  expect(html).toContain('href="https://signals.cypho.io/"');
  expect(html).toContain('<code>signals.cypho.io</code>');
  expect(html).not.toContain('Open signals.cypho.io');
  expect(html).toContain('Open PLAN.md');
});

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


test('bare filenames resolve uniquely inside the chat workspace without guessing explicit paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-basename-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'jolo-other-workspace-'));
  const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }, { id: 'other', path: other, present: true }] };
  try {
    await mkdir(path.join(root, 'apps/cli/npm'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/dependency'), { recursive: true });
    await writeFile(path.join(root, 'apps/cli/npm/install.js'), 'nested installer');
    await writeFile(path.join(root, 'node_modules/dependency/install.js'), 'dependency');
    await writeFile(path.join(other, 'install.js'), 'another workspace');
    await writeFile(path.join(other, 'external.js'), 'outside');
    await symlink(other, path.join(root, 'linked-directory'));
    expect(await previewChatFile(call, { sessionId: 's', path: 'install.js:12' })).toMatchObject({ text: 'nested installer', kind: 'text' });
    await expect(previewChatFile(call, { sessionId: 's', path: './install.js' })).rejects.toThrow('File not found');
    await expect(previewChatFile(call, { sessionId: 's', path: 'wrong/install.js' })).rejects.toThrow('File not found');
    await expect(previewChatFile(call, { sessionId: 's', path: 'external.js' })).rejects.toThrow('File not found');
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts/install.js'), 'another installer');
    await expect(previewChatFile(call, { sessionId: 's', path: 'install.js' })).rejects.toThrow('More than one file');
    expect(await previewChatFile(call, { sessionId: 's', path: 'apps/cli/npm/install.js' })).toMatchObject({ text: 'nested installer' });
    await writeFile(path.join(root, 'install.js'), 'root installer');
    expect(await previewChatFile(call, { sessionId: 's', path: 'install.js' })).toMatchObject({ text: 'root installer' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
