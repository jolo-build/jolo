import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import App from '../src/App.jsx';

// Publish useful HTML before JavaScript loads, including for search engines.
const path = new URL('../dist/index.html', import.meta.url);
// Mark the modules and styles emitted by Vite so startup ignores assets injected
// by extensions. Vite does not preserve custom attributes on the entry script.
const html = (await readFile(path, 'utf8')).replace(/<(?:script|link)\b[^>]*>/g, tag =>
  /(?:src|href)="\/assets\//.test(tag) && !tag.includes('data-jolo-asset')
    ? tag.replace(/>$/, ' data-jolo-asset>') : tag);
const marker = '<div id="root"></div>';
if (!html.includes(marker)) throw new Error('Missing prerender mount point');
await writeFile(path, html.replace(marker, `<div id="root">${renderToString(<App />)}</div>`));

// Permit only the exact startup code and critical CSS emitted by this build.
// Keep the public site's CSP strict without enabling arbitrary inline content.
const hash = (tag, id) => {
  const source = html.match(new RegExp(`<${tag} id="${id}">([\\s\\S]*?)<\\/${tag}>`))?.[1];
  if (!source) throw new Error(`Missing ${id}`);
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
};
const headersPath = new URL('../dist/_headers', import.meta.url);
const headers = await readFile(headersPath, 'utf8');
await writeFile(headersPath, headers
  .replace("script-src 'self'", `script-src 'self' ${hash('script', 'startup-script')}`)
  .replace("style-src 'self'", `style-src 'self' ${hash('style', 'startup-style')}`));
