import { existsSync } from 'node:fs';
const base=new URL('./dist/',import.meta.url);
Bun.serve({port:8792,hostname:'127.0.0.1',async fetch(req){const path=new URL(req.url).pathname;const file=new URL('.'+(path.endsWith('/')?path+'index.html':path),base);if(!file.href.startsWith(base.href))return new Response('Not found',{status:404});if(existsSync(file))return new Response(Bun.file(file));return new Response(Bun.file(new URL('404.html',base)),{status:404});}});console.log('Guide preview at http://127.0.0.1:8792');
