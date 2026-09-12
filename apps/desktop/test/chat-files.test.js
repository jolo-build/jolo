import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openChatFile } from '../src/main/chat-files.js';
import { parseInline } from '@jolo/markdown';

test('preserves local Markdown destinations and rejects executable URL schemes', () => {
  expect(parseInline('[Download](report.pdf)')[0]).toMatchObject({ type: 'link', local: true, href: 'report.pdf' });
  expect(parseInline('[Download](sandbox:/tmp/report.pdf)')[0]).toMatchObject({ local: true, href: '/tmp/report.pdf' });
  expect(parseInline('[bad](javascript:report.pdf)')[0].type).toBe('text');
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
