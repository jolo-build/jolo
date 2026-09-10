import { failStartup, showStartup } from "./startup.js";

window.addEventListener('beforeunload', showStartup);

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Could not load ${href}`));
    document.head.append(link);
  });
}

async function start() {
  // Let the small HTML splash finish loading and paint before parsing React or
  // fetching application styles. Neither should hold up the first visible frame.
  if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const [renderer] = await Promise.all([
    import('./render.jsx'),
    loadStylesheet('xterm.css'),
    loadStylesheet('styles.css'),
  ]);
  renderer.render();
}
void start().catch(failStartup);
