import { copyFile, mkdir } from 'node:fs/promises';

const destination = new URL('../public/assets/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const [source, name] of [
  ['brand/favicon.svg', 'favicon.svg'],
  ['brand/favicon.png', 'favicon.png'],
  ['fonts/JetBrainsMono-latin.woff2', 'mono.woff2'],
  ['fonts/Inter-latin.woff2', 'inter.woff2'],
  ['fonts/LICENSE-Inter.txt', 'LICENSE-Inter.txt'],
  ['fonts/LICENSE-JetBrainsMono.txt', 'LICENSE-JetBrainsMono.txt'],
]) {
  await copyFile(new URL(`../../../assets/${source}`, import.meta.url), new URL(name, destination));
}

const bundle = await Bun.build({ entrypoints: [new URL('../src/tasks/markdown-editor.js', import.meta.url).pathname], outdir: destination.pathname, naming: 'task-markdown.js', target: 'browser', minify: true });
if (!bundle.success) throw new Error(`Markdown editor build failed: ${bundle.logs.join('\n')}`);
