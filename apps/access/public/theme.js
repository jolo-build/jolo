// Apply the saved preference before styles paint. System mode also works without JavaScript.
(() => {
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
