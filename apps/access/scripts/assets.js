import { copyFile, mkdir } from 'node:fs/promises';

const destination = new URL('../public/assets/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const [source, name] of [
  ['fonts/JetBrainsMono-latin.woff2', 'mono.woff2'],
  ['fonts/LICENSE-JetBrainsMono.txt', 'LICENSE-JetBrainsMono.txt'],
]) {
  await copyFile(new URL(`../../../assets/${source}`, import.meta.url), new URL(name, destination));
}
