import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openChatFile, previewChatFile } from '../src/main/chat-files.js';
import { createFilePreviewStore } from '../src/main/file-preview-store.js';
import { parseInline } from '@jolo/markdown';
import { automaticFileReference, fileReference, webReference } from '@jolo/markdown/file-links';

test('bare web addresses are not file references, while explicit paths remain files', () => {
  for (const target of ['access.jolo.build', 'docs.jolo.build', 'jolo.build/releases/desktop.json', 'signals.cypho.io', 'cypho.io', 'example.com/docs/PLAN.md', 'signals.cypho.io:8443', 'www.example.com', 'example.ai', 'localhost:3000']) {
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

test('bare domains stay code while explicit URLs and local paths remain clickable', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  const html = renderToStaticMarkup(createElement(Markdown, { text: 'Configuration for `signals.cypho.io`, `https://signals.cypho.io`, and `./PLAN.md`.', cacheKey: 'domain', sessionId: 's' }));
  expect(html).toContain('href="https://signals.cypho.io/"');
  expect(html).toContain('<code>signals.cypho.io</code>,');
  expect(html.match(/<a /g)).toHaveLength(2);
  expect(html).not.toContain('Open signals.cypho.io');
  expect(html).toContain('Open ./PLAN.md');
});

test('timings in prose and inline code stay text while file paths remain clickable', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  for (const text of ['**429s kill runs in ~1.5s**', '`429s kill runs in ~1.5s`', '`1.5s`', 'See ./src/app.js; **429s kill runs in ~1.5s**', 'Version 1.2']) {
    const html = renderToStaticMarkup(createElement(Markdown, { text, cacheKey: text, sessionId: 's' }));
    expect(html.match(/<a /g) ?? []).toHaveLength(text.includes('app.js') ? 1 : 0);
    if (text.includes('app.js')) expect(html).toContain('Open ./src/app.js');
  }
  expect(fileReference('429s kill runs in ~1.5s')).toBeNull();
  expect(fileReference('1.5s')).toBeNull();
  expect(fileReference('recording.mp3')).toBe('recording.mp3');
  expect(fileReference('./snapshot.123', { explicit: true })).toBe('./snapshot.123');
});

test('website reports do not turn domains, asset names or extensions into local file links', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  const text = '[Access](https://access.jolo.build), [Docs](https://docs.jolo.build), [Analytics](https://static.cloudflareinsights.com/beacon.min.js); `access.jolo.build`, `docs.jolo.build`, `static.cloudflareinsights.com/beacon.min.js`, `desktop.json`, latest.txt, `.tar.gz`; `./apps/website/src/App.jsx`; [Local config](desktop.json).';
  const html = renderToStaticMarkup(createElement(Markdown, { text, cacheKey: 'website-report', sessionId: 's' }));
  expect(html).toContain('href="https://access.jolo.build/"');
  expect(html).toContain('href="https://docs.jolo.build/"');
  expect(html).toContain('href="https://static.cloudflareinsights.com/beacon.min.js"');
  expect(html).toContain('<code>desktop.json</code>');
  expect(html).toContain('<code>.tar.gz</code>');
  expect(html).toContain('Open ./apps/website/src/App.jsx');
  expect(html).toContain('Open desktop.json'); // An explicit Markdown destination remains a local link.
  expect(html.match(/href="#"/g)).toHaveLength(2);
  expect(html.match(/<a /g)).toHaveLength(5);
  for (const reference of ['desktop.json', 'latest.txt', '.tar.gz', 'access.jolo.build']) expect(automaticFileReference(reference)).toBeNull();
  for (const reference of ['./desktop.json', './src/app.js', 'app.js:42', 'file:///tmp/report.pdf']) expect(automaticFileReference(reference)).toBe(fileReference(reference, { explicit: true }));
});

test('preserves local Markdown destinations and rejects executable URL schemes', () => {
  expect(parseInline('[Download](report.pdf)')[0]).toMatchObject({ type: 'link', local: true, href: 'report.pdf' });
  expect(parseInline('[Download](sandbox:/tmp/report.pdf)')[0]).toMatchObject({ local: true, href: 'sandbox:/tmp/report.pdf' });
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

test('shortened paths resolve by unique directory suffix, with exact and explicit paths respected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-path-suffix-'));
  const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }] };
  try {
    for (const directory of ['apps/engine/src/agent', 'apps/engine/src/browser', 'node_modules/pkg/agent']) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, 'apps/engine/src/agent/instructions.js'), 'agent instructions');
    await writeFile(path.join(root, 'apps/engine/src/browser/instructions.js'), 'browser instructions');
    await writeFile(path.join(root, 'node_modules/pkg/agent/instructions.js'), 'dependency');
    expect(await previewChatFile(call, { sessionId: 's', path: 'agent/instructions.js:12:3' })).toMatchObject({ kind: 'text', text: 'agent instructions', path: expect.stringContaining('/apps/engine/src/agent/instructions.js') });
    for (const reference of ['./agent/instructions.js', '../agent/instructions.js', 'wrong/instructions.js', path.join(root, 'agent/instructions.js')]) {
      await expect(previewChatFile(call, { sessionId: 's', path: reference })).rejects.toThrow('File not found');
    }
    await mkdir(path.join(root, 'other/agent'), { recursive: true });
    await writeFile(path.join(root, 'other/agent/instructions.js'), 'other instructions');
    await expect(previewChatFile(call, { sessionId: 's', path: 'agent/instructions.js' })).rejects.toThrow('More than one file');
    await mkdir(path.join(root, 'agent'));
    await writeFile(path.join(root, 'agent/instructions.js'), 'exact instructions');
    expect(await previewChatFile(call, { sessionId: 's', path: 'agent/instructions.js' })).toMatchObject({ text: 'exact instructions' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prose and inline code use the same complete references without linkifying website routes', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  const render = text => renderToStaticMarkup(createElement(Markdown, { text, cacheKey: text, sessionId: 's' }));
  for (const reference of ['/install.sh', 'releases/latest.txt', '//cdn.example.com/file.js', 'example.sh/install.sh', '/download?file=report.pdf', 'docs/My%20Report.pdf', '/tmp/report.pdf']) {
    for (const text of [reference, `\`${reference}\``]) expect(render(text)).not.toContain('<a ');
  }
  for (const reference of ['./scripts/install.sh', './report(final).pdf', '~/notes/report.md', 'src/app.js#L12', 'app.js:12:3', 'C:\\repo\\app.js']) {
    for (const text of [reference, `\`${reference}\``]) expect(render(text)).toContain(`title="Open ${reference}"`);
  }
  expect(render('[::1]:3000/app.js')).toContain('href="http://[::1]:3000/app.js"');
  expect(render('`cat /tmp/report.pdf`')).not.toContain('<a ');
  expect(render('[Installer](https://jolo.build/install.sh)')).toContain('href="https://jolo.build/install.sh"');
  expect(render('[Source](src/app.js:12:3)')).toContain('Open src/app.js:12:3');
  expect(render('[Encoded](docs/My%2520Report.pdf)')).toContain('Open docs/My%2520Report.pdf');
  const web = renderToStaticMarkup(createElement(Markdown, { text: 'See `/install.sh`, [releases](latest.txt) and [CDN](//cdn.example.com/file.js), [changelog](/changelog/).', cacheKey: 'web-base', sessionId: 's', webBaseUrl: 'https://jolo.build/releases/' }));
  expect(web).toContain('href="https://jolo.build/install.sh"');
  expect(web).toContain('href="https://jolo.build/releases/latest.txt"');
  expect(web).toContain('href="https://cdn.example.com/file.js"');
  expect(web).toContain('href="https://jolo.build/changelog/"');
  expect(web.match(/<a /g)).toHaveLength(4);
});

test('file resolution preserves source locations, home paths and encoded or literal filenames', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-file-paths-'));
  const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }] };
  try {
    for (const name of ['My Report.txt', 'My%20Report.txt', 'question?#.txt', 'source.js', 'literal:12']) await writeFile(path.join(root, name), name);
    const preview = (reference, options = {}) => previewChatFile(call, { sessionId: 's', path: reference, ...options });
    expect(await preview('My%20Report.txt', { urlEncoded: true })).toMatchObject({ text: 'My Report.txt' });
    expect(await preview('My%2520Report.txt', { urlEncoded: true })).toMatchObject({ text: 'My%20Report.txt' });
    expect(await preview('My%20Report.txt')).toMatchObject({ text: 'My%20Report.txt' });
    expect(await preview('question%3F%23.txt', { urlEncoded: true })).toMatchObject({ text: 'question?#.txt' });
    expect(await preview(path.join(root, 'literal:12'), { nativePath: true })).toMatchObject({ text: 'literal:12', line: undefined });
    expect(await preview(`~/${path.relative(os.homedir(), path.join(root, 'source.js'))}`)).toMatchObject({ text: 'source.js' });
    for (const reference of ['source.js:12:3', 'source.js#L12C3']) expect(await preview(reference)).toMatchObject({ line: 12, column: 3, text: 'source.js' });
    await mkdir(path.join(root, 'directory.md'));
    await expect(preview('directory.md')).rejects.toMatchObject({ code: 'FILE_IS_DIRECTORY' });
    await expect(preview('missing.js')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(preview('javascript:report.pdf')).rejects.toMatchObject({ code: 'FILE_INVALID_REFERENCE' });
    if (process.platform !== 'win32') await expect(preview('C:\\repo\\source.js')).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED_PLATFORM' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('media previews reuse capacity per chat while stale leases cannot close another preview', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-preview-leases-'));
  const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }] };
  try {
    for (let i = 0; i < 9; i++) await writeFile(path.join(root, `${i}.png`), `image ${i}`);
    const store = createFilePreviewStore(call);
    const prepare = (name, sessionId = 's') => store.prepare({ sessionId, path: name });
    /** @type {any[]} */
    const previews = [];
    for (let i = 0; i < 8; i++) previews.push(await prepare(`${i}.png`));
    const reopened = /** @type {any} */ (await prepare('0.png'));
    store.release(reopened.url);
    const first = previews[0];
    expect(await store.response(new Request(first.url)).text()).toBe('image 0');
    await expect(prepare('8.png')).rejects.toMatchObject({ code: 'FILE_PREVIEW_LIMIT' });
    const anotherChat = /** @type {any} */ (await prepare('8.png', 'other'));
    expect(store.has(anotherChat.url)).toBe(true);
    store.release(previews[1].url);
    const replacement = /** @type {any} */ (await prepare('8.png'));
    expect(store.has(replacement.url)).toBe(true);
    store.clear();
    expect(store.has(first.url)).toBe(false);
    expect(store.has(anotherChat.url)).toBe(false);
    expect(store.has(replacement.url)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('property names in the reported context-window analysis stay text while source locations remain links', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { Markdown } = await import('../src/renderer/components/markdown.jsx');
  const render = text => renderToStaticMarkup(createElement(Markdown, { text, cacheKey: text, sessionId: 's' }));
  for (const name of ['factory.learned', 'factory.learned.get', 'account.name', 'response.status', 'Array.from', 'console.log', 'config.model']) {
    for (const text of [name, `\`${name}\``]) expect(render(text)).not.toContain('<a ');
  }
  const html = render('**Learned context windows do not survive restarts or new runs.** `factory.learned` is in-memory; `setRunProviderConfig` covers resume.\n\nindex.js:67');
  expect(html).toContain('<code>factory.learned</code>');
  expect(html).not.toContain('https://factory.learned');
  expect(html).toContain('title="Open index.js:67"');
  expect(html.match(/<a /g)).toHaveLength(1);
});
