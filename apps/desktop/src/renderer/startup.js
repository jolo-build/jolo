// The initial HTML owns the splash, so it can paint before React or the engine is ready.
export function finishStartup() {
  document.getElementById('startup-screen').hidden = true;
  const root = document.getElementById('root');
  root.inert = false;
  root.setAttribute('aria-busy', 'false');
}

export function showStartup() {
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
  screen.querySelector('.startup-detail').hidden = false;
  screen.querySelector('button').onclick = () => window.location.reload();
}
