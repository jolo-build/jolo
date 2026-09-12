import assert from 'node:assert/strict';
import { dialog, nativeTheme } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIRST_TASKS } from '../src/renderer/onboarding.js';

export async function runOnboardingSmoke({ window, bridge, project, results, evaluate, waitFor, report }) {
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const button = label => evaluate(`Array.from(document.querySelectorAll('.onboarding button, .settings-page button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const next = () => click('.onboarding-actions .primary');
  const atStep = step => waitFor(`document.querySelector('.onboarding-card h2')?.textContent === ${JSON.stringify(step)}`, step);
  const reload = async () => {
    await new Promise((resolve, reject) => {
      const loaded = () => { clearTimeout(timer); resolve(null); };
      const timer = setTimeout(() => { window.webContents.removeListener('did-finish-load', loaded); reject(new Error('Onboarding reload timed out')); }, 10000);
      window.webContents.once('did-finish-load', loaded);
      window.webContents.reload();
    });
    await waitFor("Boolean(window.__joloSmoke?.state) && document.getElementById('startup-screen').hidden", 'reloaded workspace');
  };
  const capture = async name => {
    await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    assert.equal(await evaluate("(() => { const element = document.querySelector('.onboarding'); return element.scrollWidth > element.clientWidth; })()"), false, 'Onboarding overflows horizontally');
    writeFileSync(path.join(results, name), (await window.webContents.capturePage()).toPNG());
  };
  const theme = nativeTheme.themeSource;
  const bounds = window.getBounds();
  const originalDialog = dialog.showOpenDialog;
  try {
    await atStep('Choose an agent');
    await waitFor("document.querySelector('.onboarding-option input[value=claude]:not(:disabled)')", 'installed agents detected');
    assert.equal((await evaluate('window.__joloSmoke.state()')).projectId, null);
    for (const mode of /** @type {const} */ (['light', 'dark'])) {
      nativeTheme.themeSource = mode;
      await capture(`onboarding-agents-${mode}.png`);
    }
    await click('.onboarding-option input[value=jolo]');
    assert.equal(await evaluate("document.querySelector('.onboarding-actions .primary').disabled"), true, 'Unconfigured provider can proceed');
    await button('Set up API provider');
    await waitFor("document.querySelector('.settings-provider-tabs button')", 'provider settings opened from guide');
    await button('Smoke Model');
    await button('Find models');
    await waitFor("document.querySelector('[aria-label=\"Model for Jolo\"] option[value=\"test-model\"]')", 'fixture model discovered');
    await evaluate("(() => { const input = document.querySelector('[aria-label=\"Model for Jolo\"]'); input.value = 'test-model'; input.dispatchEvent(new Event('change', {bubbles:true})); })()");
    await button('Use as default');
    await waitFor("document.querySelector('.settings-provider [role=status]')?.textContent.includes('Default model saved')", 'native model saved');
    await click('[aria-label="Back to workspace"]');
    await waitFor("document.querySelector('.onboarding-option input[value=jolo]:checked') && !document.querySelector('.onboarding-actions .primary').disabled", 'guide recognizes configured provider');
    await click('.onboarding-option input[value=codex]');
    await next(); await atStep('Open a project');
    assert.equal(await evaluate("document.querySelector('.onboarding-actions .primary').disabled"), true);
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    await button('Choose folder');
    await waitFor("document.querySelector('.onboarding-folder button')?.textContent === 'Choose folder'", 'cancelled picker leaves guide intact');
    assert.equal((await evaluate('window.__joloSmoke.state()')).projectId, null);
    dialog.showOpenDialog = async () => { throw new Error('Folder picker unavailable'); };
    await button('Choose folder');
    await waitFor("document.querySelector('.onboarding-error')?.textContent.includes('Folder picker unavailable')", 'folder errors stay visible in guide');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    await button('Choose folder');
    await waitFor("document.querySelector('.onboarding-folder button')?.textContent === 'Change folder'", 'folder opened');
    await capture('onboarding-project.png');
    await reload();
    await atStep('Choose an agent');
    await waitFor("document.querySelector('.onboarding-option input[value=codex]:checked') && !document.querySelector('.onboarding-actions .primary').disabled", 'agent preference survives reload');
    await next(); await atStep('Open a project');
    assert.match(await evaluate("document.querySelector('.onboarding-folder').textContent"), /repo/);
    await next(); await atStep('Try a first task');
    assert.equal(await evaluate("document.activeElement === document.querySelector('.onboarding-card h2')"), true, 'step changes move focus to heading');
    await capture('onboarding-task-dark.png');
    nativeTheme.themeSource = 'light';
    window.setSize(600, 700);
    await capture('onboarding-task-narrow.png');
    await evaluate("document.querySelector('.onboarding-actions .primary').scrollIntoView({block:'center'})");
    assert.equal(await evaluate("(() => {const rect = document.querySelector('.onboarding-actions .primary').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;})()"), true, 'Narrow window cannot reach the final action');
    await capture('onboarding-task-narrow-actions.png');
    window.setBounds(bounds);
    await next();
    await waitFor("document.querySelector('.composer textarea')?.value.startsWith('Explain how this project')", 'suggestion opens as editable draft');
    const first = await evaluate('window.__joloSmoke.state()');
    assert.equal(first.runCount, 0, 'Guide ran a task without sending');
    assert.equal(first.sessionAgentId, 'codex');
    assert.equal(await evaluate("document.querySelector('.composer textarea').value"), FIRST_TASKS[0].prompt);
    assert.equal(await evaluate("localStorage.getItem('jolo.onboarding.v1')"), 'completed');
    await click('.composer-submit');
    await waitFor("window.__joloSmoke.state().runState === 'completed'", 'user sends the first task through selected agent');
    await evaluate('window.__joloSmoke.newTask()');
    await waitFor(`window.__joloSmoke.state().sessionId !== ${JSON.stringify(first.sessionId)}`, 'next task created');
    assert.equal(await evaluate("document.querySelector('.composer textarea').value"), '', 'first-task suggestion leaks into another task');
    assert.equal((await evaluate('window.__joloSmoke.state()')).sessionAgentId, 'codex');
    await evaluate('window.__joloSmoke.showBoard()');
    await waitFor("document.querySelector('.board-get-started button') && !document.querySelector('.onboarding')", 'completed guide stays closed');
    await click('.board-get-started button');
    await atStep('Choose an agent');
    await click('.onboarding-footer button');
    await reload();
    await waitFor("document.querySelector('.board-get-started button') && !document.querySelector('.onboarding')", 'skip survives reload');
    // Existing users have no guide marker when upgrading; their projects must be respected.
    await evaluate("localStorage.removeItem('jolo.onboarding.v1')");
    await reload();
    await waitFor("document.querySelector('.board-get-started button') && !document.querySelector('.onboarding')", 'existing profile is not interrupted on upgrade');
    assert.equal(await evaluate("localStorage.getItem('jolo.onboarding.v1')"), 'dismissed');
    report.checks.push('Fresh-profile onboarding detects installed agents, blocks unconfigured providers, and resumes after API provider setup.');
    report.checks.push('Folder cancellation and failure recover; chosen agent and folder survive reload; step focus and light/dark/narrow layouts pass.');
    report.checks.push('Suggested first task is an editable draft with no automatic run; sending executes the selected agent; later tasks retain its choice with empty drafts.');
    report.checks.push('Guide can reopen from the board; completion, dismissal and existing-profile upgrade keep it from appearing automatically.');
  } finally {
    dialog.showOpenDialog = originalDialog;
    nativeTheme.themeSource = theme;
    window.setBounds(bounds);
  }
}
