import { renderMarkdown } from './markdown.js';

for (const editor of document.querySelectorAll('[data-markdown-editor]')) {
  const input = editor.querySelector('textarea');
  const preview = /** @type {HTMLElement} */ (editor.querySelector('[data-markdown-preview]'));
  const tabs = /** @type {HTMLElement} */ (editor.querySelector('[data-markdown-tabs]'));
  tabs.hidden = false;
  for (const button of tabs.querySelectorAll('button')) button.addEventListener('click', () => {
    const showing = button.dataset.mode === 'preview';
    if (showing) preview.innerHTML = renderMarkdown(input.value) || '<p class="fine">Nothing to preview yet.</p>';
    input.hidden = showing;
    preview.hidden = !showing;
    for (const tab of tabs.querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab === button));
    if (!showing) input.focus();
  });
}
