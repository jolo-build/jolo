import { expect, test } from 'bun:test';
import { browserTaskCompletion } from '../src/renderer/browser-task-completion.js';
import { PanelTabs } from '../src/renderer/panel-tabs.js';

const tool = (runId = 'run-a', sessionId = 'a', name = 'browser_snapshot', status = 'ok') => ({ runId, sessionId, type: 'tool.completed', payload: { name, status } });
const state = (value, runId = 'run-a', sessionId = 'a') => ({ runId, sessionId, type: 'run.state', payload: { state: value } });

test('completed browser work closes its panel, preserves pages, and leaves another chat alone', () => {
  const tabs = new PanelTabs();
  for (const scope of ['a', 'b']) {
    tabs.add(scope, { id: scope, panelType: 'browser', url: `https://${scope}.example` });
    tabs.setContext(scope, 'browser');
  }
  const receive = browserTaskCompletion(session => tabs.hideBrowser(session));
  receive(tool());
  receive(state('tools'));
  expect(tabs.get('a').context).toBe('browser');
  receive(state('completed'));
  expect(tabs.get('a').context).toBeNull();
  expect(tabs.get('a').items[0].url).toBe('https://a.example');
  expect(tabs.get('b').context).toBe('browser');
  tabs.setContext('a', 'browser');
  receive(state('completed')); // replay must not close a manually reopened panel
  expect(tabs.get('a').context).toBe('browser');
});

test('unrelated runs, listing tabs, failed tools and interrupted jobs do not close the browser', () => {
  const closed = [];
  const receive = browserTaskCompletion(session => closed.push(session));
  for (const name of ['read_file', 'browser_tabs']) { receive(tool('run-a', 'a', name)); receive(state('completed')); }
  receive(tool('run-a', 'a', 'browser_open', 'error')); receive(state('completed'));
  for (const terminal of ['failed', 'cancelled', 'interrupted']) { receive(tool()); receive(state(terminal)); receive(state('completed')); }
  expect(closed).toEqual([]);
  receive(tool()); receive(state('paused')); expect(closed).toEqual([]);
  receive(state('tools')); receive(state('completed')); expect(closed).toEqual(['a']);
});

test('finishing browser work does not hide another panel or concurrent browser work', () => {
  const tabs = new PanelTabs();
  tabs.setContext('a', 'files');
  const receive = browserTaskCompletion(session => tabs.hideBrowser(session));
  receive(tool()); receive(state('completed'));
  expect(tabs.get('a').context).toBe('files');
  tabs.setContext('a', 'browser');
  receive(tool()); receive(tool('run-b'));
  receive(state('completed')); expect(tabs.get('a').context).toBe('browser');
  receive(state('completed', 'run-b')); expect(tabs.get('a').context).toBeNull();
});
