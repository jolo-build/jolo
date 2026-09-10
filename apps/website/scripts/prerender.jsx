import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFile, writeFile } from 'node:fs/promises';
import App from '../src/App.jsx';

// Publish useful HTML before JavaScript loads, including for search engines.
const path = new URL('../dist/index.html', import.meta.url);
const html = await readFile(path, 'utf8');
const marker = '<div id="root"></div>';
if (!html.includes(marker)) throw new Error('Missing prerender mount point');
await writeFile(path, html.replace(marker, `<div id="root">${renderToString(<App />)}</div>`));
