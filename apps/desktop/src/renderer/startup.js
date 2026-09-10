// The initial HTML owns the splash, so it can paint before React or the engine is ready.
let revision = 0;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

export function finishStartup() {
  const screen = document.getElementById('startup-screen');
  if (screen.hidden || screen.hasAttribute('data-failed')) return;
  const root = document.getElementById('root');
  const current = ++revision;
  void (async () => {
    // React has committed the shell and its initial data. Keep rendering behind
    // the opaque splash until its fonts, images, and resulting layout are ready.
    await nextFrame();
    root.getBoundingClientRect(); // Start font loads required by the committed layout.
    await Promise.all([
      document.fonts.ready,
      ...[...root.querySelectorAll('img')].map(img => img.decode().catch(() => {})),
    ]);
    await nextFrame();
    await nextFrame();
    if (current !== revision) return;
    screen.hidden = true;
    root.inert = false;
    root.setAttribute('aria-busy', 'false');
  })().catch(error => { if (current === revision) failStartup(error); });
  // An unmount, readiness change, or reload must invalidate a pending reveal.
  return () => { if (current === revision) revision++; };
}

export function showStartup() {
  revision++;
  document.getElementById('startup-screen').hidden = false;
  const root = document.getElementById('root');
  root.inert = true;
  root.setAttribute('aria-busy', 'true');
}

export function failStartup(error) {
  console.error('Desktop startup failed', error);
  showStartup();
  const screen = document.getElementById('startup-screen');
  screen.dataset.failed = '';
  screen.setAttribute('aria-label', 'Jolo couldn’t finish loading');
  screen.querySelector('.startup-status').hidden = true;
  screen.querySelector('.startup-detail:not(.startup-status)').hidden = false;
  screen.querySelector('button').onclick = () => window.location.reload();
}
