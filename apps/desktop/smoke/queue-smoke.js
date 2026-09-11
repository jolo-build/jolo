import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runQueueSmoke({ evaluate, waitFor, bridge, window, results }) {
  await evaluate("window.__joloSmoke.newTask()");
  await evaluate("window.__joloSmoke.pickAnswerer('grok')");
  await waitFor("window.__joloSmoke.state().answerer === 'Grok CLI'", 'queue answerer');
  const first = await evaluate("window.__joloSmoke.send('sleep for queue smoke')");
  await waitFor("Boolean(document.querySelector('.composer [aria-label=\"Stop task\"]'))", 'queue active turn');
  const sessionId = await evaluate('window.__joloSmoke.state().sessionId');
  const draft = async text => {
    await evaluate(`(() => { const input = document.querySelector('.composer textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  };
  const enter = count => evaluate(`(() => { const input = document.querySelector('.composer textarea'); for (let n = 0; n < ${count}; n++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await draft('queued follow-up');
  await enter(1);
  await waitFor("document.querySelector('.message-queue')?.textContent.includes('queued follow-up')", 'message queued');
  await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }))");
  if ((await bridge.rawCall('run.snapshot', { runId: first.id })).run.state !== 'model') throw new Error('single Enter interrupted active work');
  // Removing and reopening exercise the saved queue rather than component-only state.
  await draft('remove this follow-up'); await enter(1);
  await waitFor("document.querySelectorAll('.message-queue li').length === 2", 'second queued message');
  await evaluate("[...document.querySelectorAll('.message-queue li')].find(row => row.textContent.includes('remove this')).querySelector('[aria-label=\"Remove queued message\"]').click()");
  await waitFor("document.querySelectorAll('.message-queue li').length === 1", 'queued message removed');
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(sessionId)})`);
  await waitFor("document.querySelector('.message-queue')?.textContent.includes('queued follow-up')", 'queue restored');
  writeFileSync(path.join(results, 'chat-queue.png'), (await window.webContents.capturePage()).toPNG());
  await draft('send immediately'); await enter(2);
  await waitFor("!document.querySelector('.message-queue') && !document.querySelector('.composer [aria-label=\"Stop task\"]')", 'forced follow-up and remaining queue complete', 15000);
  const page = await bridge.rawCall('session.page', { sessionId });
  const prompts = page.messages.filter(message => message.role === 'user').map(message => page.runs.find(run => run.id === message.runId)?.prompt);
  if (JSON.stringify(prompts) !== JSON.stringify(['sleep for queue smoke', 'send immediately', 'queued follow-up'])) throw new Error(`queue order or double-Enter duplication: ${JSON.stringify(prompts)}`);
  if (page.runs.find(run => run.id === first.id)?.state !== 'cancelled') throw new Error('double Enter did not interrupt the old turn');
  if (page.runs.find(run => run.prompt === 'remove this follow-up')?.state !== 'cancelled') throw new Error('removed message ran');
}
