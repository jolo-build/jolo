import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { checkSettingsLayout } from './control-layout-smoke.js';

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
  assert(await evaluate("['low', 'high'].every(value => document.querySelector('[aria-label=\"Effort for Grok CLI\"] option[value=\"' + value + '\"]'))"), 'reasoning effort choices load automatically');
  assert(await evaluate("document.querySelectorAll('.agent-preferences input').length === 0"), 'agent model and effort controls must be selection-only');
  await evaluate("(() => {const select=document.querySelector('[aria-label=\"Model for Codex\"]');select.value='fake-large';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  assert(await evaluate("document.querySelector('[aria-label=\"Model for Codex\"]').selectedOptions[0].textContent === 'Fake Large'"), 'selected model shows its readable name');
  await evaluate("document.querySelector('.settings-savebar button[type=submit]').click()");
  await waitFor("window.__joloSmoke.hostedAgents().find(agent=>agent.id==='codex')?.model === 'fake-large'", 'selection-only model choice saved');
  report.checks.push('Settings automatically loaded every installed agent and its reasoning efforts without changing saved preferences');
  const themeBefore = nativeTheme.themeSource, sizeBefore = window.getSize();
  try {
    report.inputStyles = {}; report.controlLayout = {};
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
      nativeTheme.themeSource = theme;
      await tab('agents');
      report.controlLayout[theme] = await checkSettingsLayout(evaluate);
      writeFileSync(path.join(results, `settings-agents-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      await tab('provider');
      await waitFor("[...document.querySelectorAll('.settings-provider-tabs button')].some(button => button.textContent === 'OpenAI')", 'provider presets loaded');
      assert(await evaluate("[...document.querySelectorAll('.settings-provider-tabs button')].some(button => button.textContent === 'DeepSeek')"), 'the provider picker must expose newly registered presets');
      await evaluate("[...document.querySelectorAll('.settings-provider-tabs button')].find(button => button.textContent === 'DeepSeek').click()");
      await settle();
      assert(await evaluate("document.querySelector('.settings-provider input[type=password]') && [...document.querySelectorAll('.settings-provider input')].some(input => input.placeholder === 'https://api.deepseek.com')"), 'a data-only preset must use the shared credential and endpoint controls');
      await evaluate("[...document.querySelectorAll('.settings-provider-tabs button')].find(button => button.textContent === 'OpenAI').click()");
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
    assert(await evaluate("document.querySelector('.settings-provider-tabs [aria-selected=true]')?.textContent === 'OpenAI'"), 'switching settings sections lost the unsaved provider choice');
    await evaluate("[...document.querySelectorAll('.settings-provider-tabs button')].find(button => button.textContent === 'Smoke Model').click()");
    await evaluate("[...document.querySelectorAll('.settings-provider button')].find(button => button.textContent === 'Find models').click()");
    await waitFor("document.querySelector('.settings-provider [role=status]')?.textContent.includes('models available')", 'raw model discovery');
    await evaluate("(() => { const input = document.querySelector('.settings-provider [aria-label=\"Model for Jolo\"]'); input.value='test-model'; input.dispatchEvent(new Event('change', {bubbles:true})); })()");
    await evaluate("[...document.querySelectorAll('.settings-provider button')].find(button => button.textContent === 'Use as default').click()");
    await waitFor("document.querySelector('.settings-provider [role=status]')?.textContent.includes('Default model saved')", 'raw model saved');
    assert(await evaluate("window.jolo.call('settings.get', {}).then(r => r.ok && r.result.settings.model.preset === 'smoke-model' && r.result.settings.model.model === 'test-model' && r.result.settings.model.contextWindowTokens === null)"), 'model selection or automatic limits were not saved');
    await evaluate("window.jolo.call('settings.update', {model:null})");
    report.checks.push('Models discovers a fixture endpoint and saves a raw model with automatic token limits through the renderer bridge');
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
