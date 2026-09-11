export async function selectPanel(evaluate, waitFor, label) {
  await evaluate("document.querySelector('.header [aria-label=\"Panels\"]').click()");
  await waitFor("Boolean(document.querySelector('.panel-menu:popover-open'))", 'panels menu open');
  await evaluate(`document.querySelector(${JSON.stringify(`.panel-menu:popover-open [role=menuitemradio][aria-label="${label}"]`)}).click()`);
  await waitFor(`document.querySelector(${JSON.stringify(`.pane-slot.focused .context-tabs [aria-label="${label}"]`)})?.getAttribute('aria-selected') === 'true' && !document.querySelector('.pane-slot.focused .inspector').hidden`, `${label} open in the context panel`);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

export async function hidePanel(evaluate, waitFor) {
  await evaluate("document.querySelector('.header [aria-label=\"Panels\"]').click()");
  await waitFor("Boolean(document.querySelector('.panel-menu:popover-open [role=menuitem]'))", 'hide panel action available');
  await evaluate("document.querySelector('.panel-menu:popover-open [role=menuitem]').click()");
  await waitFor("document.querySelector('.pane-slot.focused .inspector').hidden", 'context panel hidden');
}
