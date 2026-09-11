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
        await document.fonts.load('400 16px "Inter"');
        await document.fonts.ready;
      }
    } catch { /* A failed font uses the system font fallback. */ }
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
    const workspace = document.querySelector('.workspace-picker');
    if (workspace) {
      const field = workspace.querySelector('select');
      const editor = document.querySelector('#task-edit');
      const draftKey = 'jolo-workspace-switch-draft';
      const names = ['title', 'description', 'state', 'priority', 'project'];
      let storageAvailable = true;
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
        sessionStorage.removeItem(draftKey);
        if (editor && saved?.team === field.value && saved?.path === location.pathname) {
          for (const name of names) if (typeof saved.values?.[name] === 'string') editor.elements[name].value = saved.values[name];
        }
      } catch { storageAvailable = false; }
      // Keep the submit fallback when a draft cannot be preserved across navigation.
      if (!editor || storageAvailable) {
        workspace.querySelector('button').hidden = true;
        field.addEventListener('change', () => {
          if (editor) {
            try {
              sessionStorage.setItem(draftKey, JSON.stringify({ path: location.pathname, team: field.value,
                values: Object.fromEntries(names.map(name => [name, editor.elements[name].value])) }));
            } catch { workspace.querySelector('button').hidden = false; return; }
          }
          workspace.requestSubmit();
        });
      }
    }
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
