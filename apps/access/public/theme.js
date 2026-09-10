// Apply the saved preference before styles paint. System mode also works without JavaScript.
(() => {
  const root = document.documentElement;
  const reveal = () => {
    clearTimeout(deadline);
    delete root.dataset.assetsLoading;
  };
  // Missing JavaScript leaves the server-rendered page visible. A stalled resource
  // must not hide sign-in forever either; failed resources settle normally below.
  const deadline = setTimeout(reveal, 8000);
  root.dataset.assetsLoading = '';
  const ready = async () => {
    try {
      if (document.fonts) {
        // Stylesheets are ready at window.load. Explicitly request the variable
        // face as well as waiting for every font used by the actual page layout.
        await document.fonts.load('400 16px "Jolo Mono"');
        await document.fonts.ready;
      }
    } catch { /* A failed font uses the existing monospace fallback. */ }
    reveal();
  };
  if (document.readyState === 'complete') void ready();
  else window.addEventListener('load', ready, { once: true });
  const key = 'jolo-access-theme';
  const normalize = value => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(key)); } catch { /* Storage may be disabled. */ }
  const apply = value => {
    preference = normalize(value);
    if (preference === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = preference;
    const picker = document.getElementById('color-theme');
    if (picker) picker.value = preference;
  };
  apply(preference);
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('color-theme');
    if (!picker) return;
    picker.value = preference;
    picker.closest('.theme-switch').hidden = false;
    picker.addEventListener('change', () => {
      apply(picker.value);
      try {
        if (preference === 'system') localStorage.removeItem(key);
        else localStorage.setItem(key, preference);
      } catch { /* The current page still changes when persistence is unavailable. */ }
    });
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
