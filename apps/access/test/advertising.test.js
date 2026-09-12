import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.js';
import { createRepository } from '../src/storage.js';
import { advertisingConfig } from '../src/advertising.js';

const ads = { X_PIXEL_ID: 'test123', X_REGISTRATION_EVENT_ID: 'tw-test123-event123' };

test('new registration emits one event; refreshes, concurrent requests, and returning sign-ins do not', async () => {
  const f = fixture(ads);
  expect((await f.login()).headers.get('location')).toBe('/welcome');
  const account = (await (await f.send('/api/session')).json()).account;
  const pages = await Promise.all([f.send('/welcome'), f.send('/welcome')]);
  const bodies = await Promise.all(pages.map(p => p.text()));
  expect(bodies.filter(body => body.includes('data-event="tw-test123-event123"'))).toHaveLength(1);
  const conversion = bodies.find(body => body.includes('data-event='));
  expect(conversion).toContain('Create your first task');
  for (const secret of [account.id, account.email, account.name, f.cookies.get('__Host-jolo_session')]) expect(conversion).not.toContain(secret);
  expect(await (await f.send('/welcome')).text()).not.toContain('/x-pixel.js');
  expect((await f.login()).headers.get('location')).toBe('/account');
  expect(await (await f.send('/welcome')).text()).not.toContain('data-event=');
});

test('only public marketing pages allow X; OAuth, device approvals, errors, and private data retain their CSP', async () => {
  const f = fixture(ads);
  const landing = await f.send('/?utm_source=x&utm_campaign=access_us_test&twclid=example');
  expect(await landing.text()).toContain('data-pixel="test123"');
  expect(landing.headers.get('content-security-policy')).toContain('https://static.ads-twitter.com');
  for (const path of ['/?user_code=ABCD-EFGH', '/?user_code=invalid', '/?error=signin', '/welcome', '/account', '/login']) {
    const response = await f.send(path);
    expect(await response.text()).not.toContain('/x-pixel.js');
    expect(response.headers.get('content-security-policy')).not.toContain('ads-twitter');
  }
  await f.login();
  for (const path of ['/account', '/tasks', '/chats', '/api/session']) {
    const response = await f.send(path);
    expect(await response.text()).not.toContain('/x-pixel.js');
    expect(response.headers.get('content-security-policy')).not.toContain('ads-twitter');
  }
  expect((await f.send('/welcome?code=private')).headers.get('location')).toBe('/welcome');
  expect(await (await f.send('/welcome')).text()).toContain('data-event=');
});

test('failed authentication and device connection flows never produce a registration event', async () => {
  const f = fixture(ads);
  f.emails[0].verified = false;
  await f.login();
  expect(f.sqlite.query('SELECT count(*) n FROM sessions').get().n).toBe(0);
  f.emails[0].verified = true;
  await f.begin('/login?user_code=ABCD-EFGH');
  expect((await f.send(f.callback())).headers.get('location')).toBe('/device?user_code=ABCD-EFGH');
  expect(f.sqlite.query('SELECT registration_event_id FROM sessions').get().registration_event_id).toBeNull();
});

test('account creation is detected by the inserted ID, including same-millisecond and concurrent logins', async () => {
  const f = fixture();
  const repo = createRepository(f.db, () => 12345);
  const identity = { id: 'concurrent', email: 'same@example.com', name: 'Same' };
  const rows = await Promise.all([repo.account(identity), repo.account(identity)]);
  expect(rows.filter(row => row.isNew)).toHaveLength(1);
  expect(rows[0].id).toBe(rows[1].id);
  expect((await repo.account(identity)).isNew).toBe(false);
  expect((await repo.account(identity, 'google')).isNew).toBe(true);
});

test('missing or invalid advertising configuration disables tracking without breaking sign-in', async () => {
  for (const config of [{}, { ...ads, X_PIXEL_ID: '<script>' }, { ...ads, X_REGISTRATION_EVENT_ID: 'tw-other-event123' }]) {
    expect(advertisingConfig(config)).toBeNull();
    const f = fixture(config);
    expect(await (await f.send('/')).text()).not.toContain('/x-pixel.js');
    expect((await f.login()).headers.get('location')).toBe('/account');
  }
});

const script = readFileSync(new URL('../public/x-pixel.js', import.meta.url), 'utf8');
test('pixel waits until page load, queues the exact event, and honors browser opt-outs', () => {
  for (const navigator of [{}, { globalPrivacyControl: true }, { doNotTrack: '1' }]) {
    const handlers = {}, inserted = [], window = { addEventListener: (name, fn) => { handlers[name] = fn; } };
    const document = { readyState: 'interactive', currentScript: { dataset: { pixel: 'test123', event: 'tw-test123-event123', conversionId: 'unique-event' } },
      head: { appendChild: node => inserted.push(node) }, createElement: () => ({}) };
    runInNewContext(script, { window, document, navigator });
    expect(inserted).toHaveLength(0);
    if (navigator.globalPrivacyControl || navigator.doNotTrack) { expect(handlers.load).toBeUndefined(); continue; }
    handlers.load();
    expect(inserted).toEqual([{ async: true, src: 'https://static.ads-twitter.com/uwt.js' }]);
    expect(window.twq.queue.map(args => Array.from(args))).toEqual([
      ['config', 'test123'], ['event', 'tw-test123-event123', { conversion_id: 'unique-event', status: 'completed' }],
    ]);
  }
});
