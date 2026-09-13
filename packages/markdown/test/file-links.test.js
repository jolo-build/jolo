import { expect, test } from 'bun:test';
import { classifyReference, parseFileReference, referenceTokens, webReference } from '../src/file-links.js';

test('ambiguous paths and commands are never inferred as local files', () => {
  for (const value of ['/install.sh', '/changelog/', 'releases/latest.txt', 'desktop.json', 'src/app.js', '/tmp/report.pdf', '//cdn.example.com/file.js', 'example.sh/install.sh', 'cat /tmp/report.pdf', '/download?file=report.pdf', 'docs/My%20Report.pdf']) {
    expect(classifyReference(value).kind).not.toBe('file');
  }
  for (const value of ['./app.js', '../app.js', '~/notes/report.md', 'file:///tmp/report.pdf', 'sandbox:/tmp/report.pdf', 'app.js:12:3', 'src/app.js#L12', 'C:\\repo\\app.js']) expect(classifyReference(value).kind).toBe('file');
  for (const value of ['javascript:report.pdf', 'data:text/plain,test.pdf', 'file://server/file.pdf', 'file:///tmp/file.pdf?download=true', 'sandbox:https://example.com/file.pdf', './file.pdf\u0000']) expect(classifyReference(value, { explicit: true }).kind).toBe('text');
});

test('web recognition covers ports, IPs and domain suffixes without guessing files', () => {
  for (const [input, href] of [
    ['example.engineering/download.json', 'https://example.engineering/download.json'],
    ['127.0.0.1:3000/app.js', 'http://127.0.0.1:3000/app.js'],
    ['[::1]:3000/app.js', 'http://[::1]:3000/app.js'],
    ['localhost:3000/app.js', 'http://localhost:3000/app.js'],
    ['https://example.sh/install.sh', 'https://example.sh/install.sh'],
    ['https://example.com:443', 'https://example.com/'],
  ]) expect(webReference(input)).toBe(href);
  for (const value of ['desktop.json', 'report.pdf', 'example.sh/install.sh', 'src/app.js', 'javascript:alert(1)']) expect(webReference(value)).toBeNull();
});

test('automatic links do not mistake dotted code identifiers for domains', () => {
  for (const value of ['factory.learned', 'factory.learned.get', 'account.name', 'response.status', 'Array.from', 'console.log', 'config.model', 'access.jolo.build', 'example.engineering/download.json']) {
    expect(['web', 'file']).not.toContain(classifyReference(value).kind);
  }
  for (const value of ['https://factory.learned', 'https://access.jolo.build', 'www.example.com', 'localhost:3000/app.js', '127.0.0.1:3000/app.js', '[::1]:3000/app.js']) {
    expect(classifyReference(value)).toEqual({ kind: 'web', href: webReference(value) });
  }
  expect(classifyReference('access.jolo.build', { explicit: true })).toEqual({ kind: 'web', href: 'https://access.jolo.build/' });
  expect(classifyReference('example.engineering/download.json', { explicit: true })).toEqual({ kind: 'web', href: 'https://example.engineering/download.json' });
  expect(classifyReference('index.js:67')).toMatchObject({ kind: 'file', reference: 'index.js:67' });
});

test('only a supplied web base resolves relative web destinations', () => {
  const webBaseUrl = 'https://jolo.build/releases/';
  for (const [value, href] of [
    ['/install.sh', 'https://jolo.build/install.sh'],
    ['latest.txt', 'https://jolo.build/releases/latest.txt'],
    ['../install.sh', 'https://jolo.build/install.sh'],
    ['//cdn.example.com/file.js', 'https://cdn.example.com/file.js'],
    ['/changelog/', 'https://jolo.build/changelog/'],
  ]) expect(classifyReference(value, { explicit: true, webBaseUrl })).toEqual({ kind: 'web', href });
  expect(classifyReference('Ordinary', { webBaseUrl }).kind).toBe('ambiguous');
  expect(classifyReference('file:///tmp/app.js', { webBaseUrl }).kind).toBe('file');
  expect(classifyReference('app.js:12', { webBaseUrl }).kind).toBe('file');
  expect(classifyReference('/install.sh', { webBaseUrl: 'file:///tmp/' }).kind).not.toBe('web');
  for (const value of ['javascript:alert(1)', 'data:text/html,test']) expect(classifyReference(value, { explicit: true, webBaseUrl }).kind).toBe('text');
});

test('references retain locations and decode URL paths exactly once', () => {
  expect(parseFileReference('src/app.js:12:3')).toMatchObject({ path: 'src/app.js', line: 12, column: 3 });
  expect(parseFileReference('src/app.js#L12C3')).toMatchObject({ path: 'src/app.js', line: 12, column: 3 });
  expect(parseFileReference('docs/My%20Report.pdf', { explicit: true, urlEncoded: true })?.path).toBe('docs/My Report.pdf');
  expect(parseFileReference('docs/My%2520Report.pdf', { explicit: true, urlEncoded: true })?.path).toBe('docs/My%20Report.pdf');
  expect(parseFileReference('./My%20Report.pdf', { explicit: true })?.path).toBe('./My%20Report.pdf');
  expect(parseFileReference('sandbox:/tmp/My%20Report.pdf', { explicit: true })?.path).toBe('/tmp/My Report.pdf');
  expect(parseFileReference('file:///tmp/My%2520Report.pdf', { explicit: true })?.path).toBe('/tmp/My%20Report.pdf');
  expect(parseFileReference('file:///tmp/question%3F%23.txt', { explicit: true })?.path).toBe('/tmp/question?#.txt');
  expect(parseFileReference('./bad%00.pdf', { explicit: true, urlEncoded: true })).toBeNull();
});

test('tokenization preserves path prefixes, queries and source locations', () => {
  const text = 'See ~/notes/report.md, //cdn.example.com/file.js; src/app.js#L12 and /download?file=report.pdf.';
  const tokens = referenceTokens(text);
  expect(tokens.join('')).toBe(text);
  for (const token of ['~/notes/report.md', '//cdn.example.com/file.js', 'src/app.js#L12', '/download?file=report.pdf']) expect(tokens).toContain(token);
});
