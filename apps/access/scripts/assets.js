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
