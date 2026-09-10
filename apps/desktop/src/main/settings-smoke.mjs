import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { checkSettingsLayout } from './control-layout-smoke.mjs';

export async function runSettingsSmoke({ window, results, evaluate, waitFor, report }) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const tab = async name => { await evaluate(`document.querySelector('.settings-nav [data-section="${name}"]').click()`); await settle(); };
  const draft = 'Keep my workspace draft';
  await evaluate(`(() => { const input = document.querySelector('.composer textarea'); window.__settingsDraftNode = input; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(draft)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await evaluate("document.querySelector('.settings-link').click()");
  await waitFor("Boolean(document.querySelector('.settings-page'))", 'settings page opened');
  assert(await evaluate("!document.querySelector('dialog[open]') && document.querySelector('.pane-canvas').inert"), 'settings must be a dedicated page with the workspace retained behind it');
  await waitFor("['Claude Code', 'Codex', 'Grok CLI'].every(name => [...document.querySelectorAll('.agent-model-row')].find(row => row.querySelector('h2')?.textContent === name)?.querySelector('.agent-model-note')?.textContent.includes('models available'))", 'installed agents load their models automatically', 20_000);
  assert(await evaluate("document.querySelector('.settings-savebar').textContent.includes('All changes saved')"), 'automatic model discovery must not change saved preferences');
  await evaluate("document.querySelector('[aria-label=\"Choose effort for grok cli\"]').click()");
  assert(await evaluate("['low', 'high'].every(value => document.querySelector('.combobox-options [data-value=\"' + value + '\"]'))"), 'reasoning efforts must load without clicking Refresh models');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))");
  report.checks.push('Settings automatically loaded every installed agent and its reasoning efforts without changing saved preferences');
  const themeBefore = nativeTheme.themeSource, sizeBefore = window.getSize();
  try {
    report.inputStyles = {}; report.controlLayout = {};
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await tab('agents');
      report.controlLayout[theme] = await checkSettingsLayout(evaluate);
      writeFileSync(path.join(results, `settings-agents-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      await tab('provider');
      await evaluate("(() => { const select = document.querySelector('.settings-provider select'); select.value = 'openai'; select.dispatchEvent(new Event('change', {bubbles:true})); })()");
      await waitFor("Boolean(document.querySelector('.settings-advanced'))", 'provider fields shown');
      await evaluate("document.querySelector('.settings-advanced').open = true");
      await settle();
      const fields = await evaluate("[...document.querySelectorAll('.settings-page input, .settings-page select')].filter(el => el.getBoundingClientRect().width).map(field => {field.focus(); const s=getComputedStyle(field); return {type:field.type, focused:document.activeElement===field, borders:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth], outline:s.outlineStyle, shadow:s.boxShadow};})");
      assert(fields.length && fields.every(field => field.focused && field.borders.every(width => width === '0px') && field.outline === 'none' && field.shadow === 'none'), 'settings fields gained borders or failed focus');
      report.inputStyles[theme] = fields;
      await checkSettingsLayout(evaluate);
      await evaluate("document.querySelector('.settings-scroll').scrollTop = 0");
      await settle();
      writeFileSync(path.join(results, `settings-inputs-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      await tab('appearance');
      writeFileSync(path.join(results, `settings-appearance-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      await tab('account');
      await waitFor("document.querySelector('.account-settings')?.textContent.includes('Sign in to Jolo')", 'account settings read the engine status');
      assert(await evaluate("document.querySelector('.account-settings').textContent.includes('works locally without signing in')"), 'account sign-in must remain optional');
      assert(await evaluate("document.querySelector('.account-settings button.primary').type === 'button'"), 'account sign-in must not submit provider settings');
      report.checks.push(`Account settings expose optional engine-backed sign-in in ${theme} mode`);
    }
    await tab('provider');
    assert(await evaluate("document.querySelector('.settings-provider select').value === 'openai'"), 'switching settings sections lost the unsaved provider choice');
    window.setSize(720, 560);
    await tab('agents');
    report.controlLayout.narrow = await checkSettingsLayout(evaluate);
    writeFileSync(path.join(results, 'settings-narrow.png'), (await window.webContents.capturePage()).toPNG());
  } finally { nativeTheme.themeSource = themeBefore; window.setSize(...sizeBefore); }
  await evaluate("document.querySelector('[aria-label=\"Back to workspace\"]').click()");
  await waitFor("!document.querySelector('.settings-page')", 'settings closed');
  assert(await evaluate(`window.__settingsDraftNode === document.querySelector('.composer textarea') && window.__settingsDraftNode.value === ${JSON.stringify(draft)}`), 'settings lost or remounted the prompt draft');
  await evaluate("(() => { const input=window.__settingsDraftNode; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', {bubbles:true})); delete window.__settingsDraftNode; })()");
  report.checks.push('Settings is a dedicated page with section navigation, a visible save bar, borderless controls in both themes, and a responsive narrow layout');
  report.checks.push('Switching settings sections preserves unsaved choices; returning to the workspace preserves the original composer node and draft');
}
