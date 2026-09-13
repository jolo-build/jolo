import { expect, test } from 'bun:test';
import { PanelTabs } from '../src/renderer/panel-tabs.js';

test('chats in one workspace have independent tabs, selection and panel visibility', () => {
  const tabs = new PanelTabs();
  tabs.add('chat-a', { id: 'browser-a', panelType: 'browser', url: 'https://first.example/' });
  tabs.add('chat-a', { id: 'terminal-a', panelType: 'terminal' });
  tabs.select('chat-a', 'browser-a');
  tabs.setContext('chat-a', 'browser');
  expect(tabs.get('chat-b')).toEqual({ items: [], activeId: null, context: null });
  tabs.add('chat-b', { id: 'browser-b', panelType: 'browser', url: 'https://second.example/' });
  tabs.setContext('chat-b', null);
  expect(tabs.get('chat-a')).toMatchObject({ activeId: 'browser-a', context: 'browser' });
  expect(tabs.get('chat-a').items.map(item => item.id)).toEqual(['browser-a', 'terminal-a']);
  expect(tabs.get('chat-b')).toMatchObject({ activeId: 'browser-b', context: null });
});

test('late updates and closing a tab affect only its originating chat', () => {
  const tabs = new PanelTabs();
  for (const chat of ['a', 'b']) tabs.add(chat, { id: '/same/file.md', title: chat });
  tabs.update('a', '/same/file.md', { title: 'late response' });
  expect(tabs.get('b').items[0].title).toBe('b');
  tabs.close('a', '/same/file.md');
  expect(tabs.get('a').items).toEqual([]);
  expect(tabs.get('b').items).toHaveLength(1);
});

test('inactive chat resources survive until their tabs or pane are closed', () => {
  const released = [];
  const tabs = new PanelTabs((item, remaining) => {
    if (!remaining.some(other => other.url === item.url)) released.push(item.url);
  });
  tabs.add('a', { id: 'file', url: 'preview:a' });
  tabs.add('b', { id: 'file', url: 'preview:b' });
  tabs.update('a', 'file', { title: 'renamed' });
  tabs.get('new-chat');
  expect(released).toEqual([]);
  tabs.close('b', 'file');
  expect(released).toEqual(['preview:b']);
  tabs.clear();
  expect(released).toEqual(['preview:b', 'preview:a']);
});
