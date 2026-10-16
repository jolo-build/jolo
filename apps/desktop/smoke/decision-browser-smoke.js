import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runDecisionBrowserSmoke({ window, bridge, evaluate, waitFor, report, results }) {
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await click('.model-select');
  await waitFor("document.querySelector('[data-source=\"provider:decision-fixture\"]')", 'decision provider available');
  await click('[data-source="provider:decision-fixture"]');
  await waitFor("document.querySelector('[data-model=\"typesafe/jev-test\"]')", 'decision model listed');
  await click('[data-model="typesafe/jev-test"]');
  await waitFor("Boolean(document.querySelector('[aria-label=\"Decision model use\"]'))", 'decision mode selector available');
  if (process.env.JOLO_TYPESAFE_SMOKE === '1') assert.equal(await evaluate("document.querySelector('[aria-label=\"Decision model use\"]').value"), 'decision-browser');
  else await evaluate("(() => { const select = document.querySelector('[aria-label=\"Decision model use\"]'); select.value = 'decision-browser'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor("document.querySelector('.composer textarea').placeholder.includes('browser')", 'direct browser mode selected');
  const searchTest = process.env.JOLO_TYPESAFE_SMOKE === '1';
  const prompt = searchTest ? `Open ${process.env.JOLO_SMOKE_BROWSER_URL}search and search emin ghuliev` : `Open ${process.env.JOLO_SMOKE_BROWSER_URL} and click the button labelled "Click" once. Finish when the button says Clicked.`;
  await evaluate(`(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('.composer-submit');
  await waitFor("['completed', 'failed', 'paused'].includes(window.__joloSmoke.state().runState)", 'decision model directly operates the browser', 60_000);
  const state = await evaluate('window.__joloSmoke.state()');
  const { run } = await bridge.rawCall('run.snapshot', { runId: state.lastRunId });
  assert.equal(run.state, 'completed', run.failure ?? run.pauseReason ?? 'Browser run did not finish');
  const session = (await bridge.rawCall('session.page', { sessionId: state.sessionId })).session;
  assert.equal(session.model.mode, 'decision-browser');
  const host = [...bridge.agent.hosts.values()].find(host => host.guest.getURL().startsWith(process.env.JOLO_SMOKE_BROWSER_URL));
  assert(host, 'inline browser reached the requested page');
  if (searchTest) assert.equal(new URL(host.guest.getURL()).searchParams.get('q'), 'emin ghuliev');
  else assert.equal(await host.guest.executeJavaScript("document.querySelector('button').textContent"), 'Clicked');
  assert.match(state.assistantText, /Browser run finished/);
  writeFileSync(path.join(results, 'decision-browser.png'), (await window.webContents.capturePage()).toPNG());
  if (process.env.JOLO_LIVE_DECISION_KEY_FILE && process.env.JOLO_SMOKE_WEB_DISCOVERY === '1') {
    await host.guest.loadURL('about:blank');
    const goal = 'Find and open the Wikipedia article about Gödel’s incompleteness theorems.';
    await evaluate(`(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(goal)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('.composer-submit');
    await waitFor(`window.__joloSmoke.state().lastRunId !== ${JSON.stringify(state.lastRunId)} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, 'discovering and opening an article without a supplied URL', 90_000);
    const discovery = await evaluate('window.__joloSmoke.state()');
    const snapshot = await bridge.rawCall('run.snapshot', { runId: discovery.lastRunId });
    assert.equal(snapshot.run.state, 'completed', snapshot.run.failure ?? snapshot.run.pauseReason);
    const article = [...bridge.agent.hosts.values()].find(candidate => {
      const url = new URL(candidate.guest.getURL());
      return url.hostname === 'en.wikipedia.org' && decodeURIComponent(url.pathname) === "/wiki/Gödel's_incompleteness_theorems";
    });
    assert(article, 'browser reached the requested Wikipedia article, not merely search results');
    writeFileSync(path.join(results, 'decision-browser-discovery.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('Live Jev discovered and opened the requested Wikipedia article with no supplied URL.');
  }
  if (!process.env.JOLO_LIVE_DECISION_KEY_FILE) {
    const goal = `Open ${process.env.JOLO_SMOKE_BROWSER_URL}exhibitors and list all fixture exhibitors. Scroll to load entries and follow Next.`;
    await evaluate(`(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(goal)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('.composer-submit');
    await waitFor(`window.__joloSmoke.state().lastRunId !== ${JSON.stringify(state.lastRunId)} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, 'scrolling and collecting across pages', 60_000);
    const result = await evaluate('window.__joloSmoke.state()');
    const snapshot = await bridge.rawCall('run.snapshot', { runId: result.lastRunId });
    assert.equal(snapshot.run.state, 'completed', snapshot.run.failure ?? snapshot.run.pauseReason);
    const last = snapshot.messages.filter(message => message.role === 'assistant').at(-1);
    const text = (await bridge.rawCall('artifact.read', { artifactId: last.artifactId })).text;
    assert.match(text, /Collected entries: 170/);
    for (let index = 0; index < 170; index++) assert.equal(text.split(`- Exhibitor ${String(index).padStart(3, '0')}\n`).length - 1, 1);
    assert(host.guest.getURL().endsWith('/exhibitors?page=2'));
    writeFileSync(path.join(results, 'decision-browser-collection.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('Collected 170 exact entries beyond the first 150 accessibility nodes, scrolled to load more, followed Next, and removed a duplicate across pages.');
  }
  report.checks.push(`${process.env.JOLO_LIVE_DECISION_KEY_FILE ? process.env.JOLO_TYPESAFE_SMOKE === '1' ? 'Live Jev through TypeSafe' : 'Live Jev through OpenRouter' : 'Decision fixture'} opened the real inline browser, navigated and clicked through direct decision mode.`);
  if (searchTest) report.checks.push('Unquoted search terms were entered and submitted exactly as supplied in the natural-language request.');
}
