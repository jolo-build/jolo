// Real Chromium key events: focus must move before the first character is inserted.
export async function runPromptFocusSmoke({ window, evaluate, waitFor, report }) {
  const state = await evaluate(`(() => {
    const panes = [...document.querySelectorAll('.pane-slot')];
    return panes.map(pane => ({ id: pane.dataset.paneId, draft: pane.querySelector('.composer textarea').value }));
  })()`);
  const first = state[0].id, second = state[1].id;
  const input = id => `document.querySelector('[data-pane-id="${id}"] .composer textarea')`;
  const focusConversation = async id => {
    window.focus();
    await evaluate(`(() => { const el = document.querySelector('[data-pane-id="${id}"] .conversation'); el.tabIndex = -1; el.focus(); })()`);
    await waitFor(`window.__joloSmoke.layout().active === '${id}'`, 'conversation pane active');
  };
  const key = async (keyCode, character, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (character) window.webContents.sendInputEvent({ type: 'char', keyCode: character, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  };
  await focusConversation(first);
  const scroll = await evaluate(`document.querySelector('[data-pane-id="${first}"] .conversation').scrollTop`);
  await key('h', 'h');
  await waitFor(`document.activeElement === ${input(first)} && ${input(first)}.value === ${JSON.stringify(state[0].draft + 'h')}`, 'first typed character reaches the active prompt');
  await key('i', 'i');
  await waitFor(`${input(first)}.value === ${JSON.stringify(state[0].draft + 'hi')}`, 'typing continues without duplicates');
  if (await evaluate(`document.querySelector('[data-pane-id="${first}"] .conversation').scrollTop`) !== scroll) throw new Error('focusing the prompt jumped the transcript');
  if (await evaluate(`${input(second)}.value`) !== state[1].draft) throw new Error('typing changed an inactive pane');

  await focusConversation(second);
  await key('x', 'x');
  await waitFor(`document.activeElement === ${input(second)} && ${input(second)}.value === ${JSON.stringify(state[1].draft + 'x')}`, 'typing follows the newly active split pane');
  await evaluate("document.querySelector('.sidebar .task[aria-current=\"page\"]').focus()");
  await key('y', 'y');
  await waitFor(`document.activeElement === ${input(second)} && ${input(second)}.value === ${JSON.stringify(state[1].draft + 'xy')}`, 'typing from the selected sidebar task reaches its prompt without losing the first character');
  await evaluate("document.querySelector('.sidebar .task-more').focus()");
  await key('z', 'z');
  if (await evaluate(`document.activeElement === ${input(second)}`)) throw new Error('task options typing stole prompt focus');
  await focusConversation(second);
  await key('ArrowLeft');
  await key('c', null, ['meta']);
  if (await evaluate(`document.activeElement === ${input(second)}`)) throw new Error('navigation or a shortcut stole prompt focus');
  await evaluate(`document.querySelector('[data-pane-id="${second}"] .pane-project').focus()`);
  await key('b', 'b');
  if (await evaluate(`document.activeElement === ${input(second)}`)) throw new Error('typing on a focused control stole prompt focus');

  await evaluate('window.__joloSmoke.showSettings()');
  await waitFor("Boolean(document.querySelector('.settings-page'))", 'Settings focus guard');
  await key('s', 's');
  if (await evaluate("Boolean(document.activeElement.closest('.composer'))")) throw new Error('Settings typing reached a hidden composer');
  await evaluate('window.__joloSmoke.closeSettings()');
  await waitFor("!document.querySelector('.settings-page')", 'Settings closed');

  for (const pane of state) await evaluate(`(() => { const el = ${input(pane.id)}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(pane.draft)}); el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-pane-id="${pane.id}"] .conversation').removeAttribute('tabindex'); })()`);
  await evaluate(`window.__joloSmoke.focusPane('${state.at(-1).id}')`);
  report.checks.push('typing in a conversation or from its selected sidebar task focuses the active prompt, keeps the first character and existing draft, and preserves other panes, shortcuts, task options, controls, Settings, and transcript scroll');
}
