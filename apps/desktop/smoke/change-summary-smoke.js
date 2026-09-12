import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { hidePanel } from './panel-controls.js';

export async function runChangeSummarySmoke({ window, project, evaluate, waitFor, report, results }) {
  await evaluate("window.__joloSmoke.send('Update the icons')");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", 'icon reply completed');
  await waitFor("document.querySelector('.change-summary-heading strong')?.textContent === 'Changed 6 files'", 'all working files counted');
  await waitFor("document.querySelector('.change-summary-heading .diff-added')?.textContent === '+6' && document.querySelector('.change-summary-heading .diff-removed')?.textContent === '−4'", 'tracked and untracked line totals loaded');
  if (await evaluate("document.querySelectorAll('.change-summary-files li').length") !== 3) throw new Error('summary must initially show three files');
  if (await evaluate("document.querySelector('.change-summary-toggle').textContent") !== 'Show 3 more files') throw new Error('remaining files count is incorrect');
  await evaluate("document.querySelector('.change-summary-toggle').click()");
  await waitFor("document.querySelectorAll('.change-summary-files li').length === 6 && document.querySelector('.change-summary-toggle').getAttribute('aria-expanded') === 'true'", 'all files expand');
  await evaluate("document.querySelector('.change-summary-toggle').click()");
  await waitFor("document.querySelectorAll('.change-summary-files li').length === 3", 'file list collapses');
  await evaluate("document.querySelector('.change-summary-review').click()");
  await waitFor("document.querySelector('.context-tabs [aria-label=Changes]')?.getAttribute('aria-selected') === 'true' && Boolean(document.querySelector('.changes .diff .diff-line'))", 'Review opens the real diff panel');
  writeFileSync(path.join(project, 'assets/icons/home.svg'), '<svg><!-- updated --></svg>\n<!-- extra line -->\n');
  await evaluate("document.querySelector('[aria-label=\"Refresh working changes\"]').click()");
  await waitFor("document.querySelector('.change-summary-heading .diff-added')?.textContent === '+7'", 'counts refresh after a file changes');
  writeFileSync(path.join(project, 'assets/icons/home.svg'), '<svg><!-- updated --></svg>\n');
  await evaluate("document.querySelector('[aria-label=\"Refresh working changes\"]').click()");
  await waitFor("document.querySelector('.change-summary-heading .diff-added')?.textContent === '+6'", 'restored counts loaded');
  await hidePanel(evaluate, waitFor);
  const theme = nativeTheme.themeSource;
  for (const mode of /** @type {const} */ (['dark', 'light'])) {
    nativeTheme.themeSource = mode;
    await evaluate("document.querySelector('.change-summary').scrollIntoView({block:'center'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const rect = await evaluate("(() => { const r = document.querySelector('.change-summary').getBoundingClientRect(); return {x:Math.floor(r.x)-12,y:Math.floor(r.y)-12,width:Math.ceil(r.width)+24,height:Math.ceil(r.height)+24}; })()");
    writeFileSync(path.join(results, `change-summary-${mode}.png`), (await window.webContents.capturePage(rect)).toPNG());
  }
  window.setSize(760, 820);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  if (!await evaluate("(() => { const card = document.querySelector('.change-summary'); return card.scrollWidth <= card.clientWidth && [...card.querySelectorAll('li')].every(row => row.scrollWidth <= row.clientWidth); })()")) throw new Error('summary overflows in a narrow window');
  nativeTheme.themeSource = theme;
  // The existing result belongs above the next prompt, even after that prompt finishes.
  const previousRun = await evaluate("document.querySelector('.change-summary').dataset.runId");
  await evaluate("window.__joloSmoke.send('Check the icons again')");
  await waitFor("window.__joloSmoke.state().runState === 'model'", 'follow-up is working');
  const oldCardBeforePrompt = `(() => { const card = document.querySelector('.change-summary[data-run-id="${previousRun}"]'); const prompt = [...document.querySelectorAll('.message.user')].at(-1); return Boolean(card && prompt && (card.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING)); })()`;
  if (!await evaluate(oldCardBeforePrompt)) throw new Error('previous changes moved below the follow-up prompt');
  writeFileSync(path.join(project, 'assets/icons/home.svg'), '<svg><!-- updated again --></svg>\n<!-- follow-up line -->\n');
  await waitFor("window.__joloSmoke.state().runState === 'completed'", 'follow-up finished');
  await waitFor("document.querySelectorAll('.change-summary').length === 2 && document.querySelectorAll('.change-summary')[1].querySelector('.diff-added')?.textContent === '+7'", 'follow-up receives its own changes card');
  if (!await evaluate(oldCardBeforePrompt)) throw new Error('previous card moved after follow-up completion');
  if (await evaluate("document.querySelector('.change-summary .diff-added').textContent") !== '+6') throw new Error('follow-up edits rewrote the previous result counts');
  const sessionId = await evaluate('window.__joloSmoke.state().sessionId');
  window.webContents.reload();
  await waitFor('Boolean(window.__joloSmoke)', 'renderer reloaded');
  await evaluate(`window.__joloSmoke.openTarget(${JSON.stringify(project)}, ${JSON.stringify(sessionId)})`);
  await waitFor("document.querySelectorAll('.change-summary').length === 2", 'both result cards restored');
  if (!await evaluate(oldCardBeforePrompt)) throw new Error('reload detached previous changes from their reply');
  if (await evaluate("document.querySelector('.change-summary .diff-added').textContent") !== '+6') throw new Error('reload lost the historical line counts');
  report.checks.push('Changed files card shows tracked and untracked line totals, expands and collapses, opens Review, refreshes after edits, and fits a narrow window');
  report.checks.push('Previous changes stay above a follow-up prompt with frozen counts, after completion and reload; new edits have their own result card');
}
