import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutSettings } from '../src/renderer/components/about-settings.jsx';

const state = { current: '0.2.8', latest: '0.2.9', available: true, managed: true, installable: true };
test('the desktop offers an in-app update and a separate restart after downloading', () => {
  expect(renderToStaticMarkup(<AboutSettings initialState={state} />)).toContain('Update to 0.2.9');
  const ready = renderToStaticMarkup(<AboutSettings initialState={{ ...state, status: 'ready' }} />);
  expect(ready).toContain('Restart to update');
  expect(ready).not.toContain('Download 0.2.9');
});
test('downloading reports progress, and update failures remain actionable', () => {
  const html = renderToStaticMarkup(<AboutSettings initialState={{ ...state, status: 'downloading', received: 50, total: 100 }} />);
  expect(html).toContain('50%');
  expect(html).toContain('aria-label="Update download"');
  const error = renderToStaticMarkup(<AboutSettings initialState={{ ...state, status: 'ready', error: 'Finish active tasks first' }} />);
  expect(error).toContain('role="alert"');
  expect(error).toContain('Finish active tasks first');
  expect(error).toContain('Restart to update');
});
