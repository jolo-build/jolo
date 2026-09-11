import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareReleaseAssets } from '../../../scripts/releases.js';

// Copy shared brand assets and licensed fonts; generated copies stay local.
for (const [folder, names] of Object.entries({
  brand: ['favicon.svg', 'favicon.png'],
  fonts: ['Inter-latin.woff2', 'JetBrainsMono-latin.woff2', 'LICENSE-Inter.txt', 'LICENSE-JetBrainsMono.txt'],
})) {
  const output = new URL(`../public/${folder}/`, import.meta.url);
  await mkdir(output, { recursive: true });
  for (const name of names) {
    await copyFile(new URL(`../../../assets/${folder}/${name}`, import.meta.url), new URL(name, output));
  }
}

await copyFile(new URL('../../../scripts/install.sh', import.meta.url), new URL('../public/install.sh', import.meta.url));
await prepareReleaseAssets(fileURLToPath(new URL('../public/releases/', import.meta.url)));
