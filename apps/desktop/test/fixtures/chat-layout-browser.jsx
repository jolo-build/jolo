// Production components, mounted in Chromium by the chat-layout smoke suite.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Conversation } from '../../src/renderer/components/conversation.jsx';
import { longSequence } from '../../../../packages/markdown/test/fixtures/long-sequence.js';

const host = document.createElement('main');
host.style.cssText = 'display:flex;flex-direction:column;height:100vh;min-height:0';
document.body.append(host);
const root = createRoot(host);
const fixtureWindow = /** @type {any} */ (window);
fixtureWindow.jolo = { call: async () => ({ ok: true, result: {} }) };
const message = { id: 'streaming', runId: 'run', role: 'assistant', kind: 'text', text: '', status: 'streaming', committedBytes: 0, renderedBytes: 0 };
const projection = { ordered: () => [message], runs: new Map([['run', { id: 'run', state: 'model' }]]) };
const render = text => {
  message.text = text;
  message.committedBytes = message.renderedBytes = text.length;
  flushSync(() => root.render(<Conversation {...(/** @type {any} */ ({ projection, sessionId: 'layout-fixture', hasProject: true }))} />));
};
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const check = (condition, description) => { if (!condition) throw new Error(description); };
const near = (a, b) => Math.abs(a - b) <= 2;
const gap = chat => chat.scrollHeight - chat.clientHeight - chat.scrollTop;

async function run() {
  // Stub only the OS clipboard boundary: exercise the actual rendered controls
  // without replacing the user's clipboard while this smoke suite runs.
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const copied = [];
  let rejectCopy = false;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
    if (rejectCopy) throw new Error('Clipboard unavailable');
    copied.push(text);
  } } });
  const diagram = 'Developer → APISIX ──→ Government API\n              │\n              └── loki-logger buffers the entry\n\n\tPOST /loki/api/v1/push  ';
  const copyChecks = [];
  try {
    for (const [language, source] of [['text', diagram], ['', '  plain text\n\twith tabs'], ['js', 'const x = "<div>";\n  console.log(x);'], ['md', '# Heading\n\n**Bold**'], ['mermaid', 'flowchart LR\n  A[Read] --> B[Write]']]) {
      render(`\`\`\`${language}\n${source}\n\`\`\``);
      await frames();
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('.md-code-copy'));
      check(Boolean(button), `Missing copy control for ${language || 'unlabeled'} fence`);
      button.click();
      await frames();
      check(copied.at(-1) === source, `Copy changed the ${language || 'unlabeled'} source or its whitespace`);
      check(button.textContent === 'Copied', 'Copy did not confirm success');
      const style = getComputedStyle(button);
      check(style.paddingLeft === style.paddingRight && parseFloat(style.paddingRight) >= 9, 'Copy hover background has unbalanced padding');
      const controls = [...button.parentElement.querySelectorAll('button')];
      check(controls.every(control => near(control.getBoundingClientRect().height, button.getBoundingClientRect().height)), 'Code header hover backgrounds have different heights');
      const toggle = /** @type {HTMLButtonElement} */ (host.querySelector('.md-embed-toggle'));
      if (toggle) { toggle.click(); await frames(); button.click(); await frames(); check(copied.at(-1) === source, 'Source view copied different contents'); }
    }
    render('```text\nstreaming first part\n```');
    await frames();
    const button = /** @type {HTMLButtonElement} */ (host.querySelector('.md-code-copy'));
    button.click(); await frames();
    render('```text\nstreaming first part\nsecond part\n```');
    await frames();
    check(button.textContent === 'Copy', 'New streamed contents still claimed to be copied');
    button.click(); await frames();
    check(copied.at(-1) === 'streaming first part\nsecond part', 'Copy used stale streamed contents');
    rejectCopy = true;
    button.click(); await frames();
    check(button.textContent === 'Retry copy' && !button.disabled, 'Clipboard failure did not offer retry');
    rejectCopy = false;
    button.click(); await frames();
    check(button.textContent === 'Copied', 'Clipboard retry failed');
    copyChecks.push('Code blocks copy exact source including tabs, spaces and line breaks, in plain, highlighted and rendered views', 'Copy uses the current streamed text and provides success feedback and retry after clipboard failure');
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
  fixtureWindow.showCopyFixture = () => { render(`\`\`\`text\n${diagram}\n\`\`\``); host.querySelector('.conversation').scrollTop = 0; };
  render('Paragraph for reading earlier results.\n\n'.repeat(60));
  await document.fonts.ready;
  await frames();
  const chat = host.querySelector('.conversation');
  /** @type {HTMLElement} */ (chat).focus();
  chat.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  await frames();
  check(getComputedStyle(chat).outlineStyle === 'none', 'Escape exposes a focus outline around the chat');
  check(gap(chat) <= 2, 'Initial transcript did not follow the latest text');
  // A tiny wheel movement must detach before a streamed commit can snap back.
  chat.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -8 }));
  chat.scrollTop -= 8;
  const pausedTop = chat.scrollTop;
  render(message.text + 'New text in the same frame.\n\n');
  await frames();
  for (let i = 0; i < 12; i++) { render(message.text + `Streaming paragraph ${i}.\n\n`); await frames(); }
  check(near(chat.scrollTop, pausedTop), 'Streaming pulled a small upward scroll back to the end');
  chat.scrollTop -= 200;
  chat.dispatchEvent(new Event('scroll'));
  const readingTop = chat.scrollTop;
  render(message.text + 'Another incoming update.\n\n');
  await frames();
  check(near(chat.scrollTop, readingTop), 'Reading older text moved during a reply');
  chat.scrollTop = chat.scrollHeight;
  chat.dispatchEvent(new Event('scroll'));
  render(message.text + 'Following again.\n\n');
  await frames();
  check(gap(chat) <= 2, 'Scrolling down to the end did not resume following');
  // An image or visualization may resize without any parent React update.
  const growing = document.createElement('div');
  growing.style.height = '300px';
  chat.querySelector('.transcript').append(growing);
  await frames();
  check(gap(chat) <= 2, 'Asynchronous content growth left the latest reply offscreen');
  chat.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }));
  chat.scrollTop -= 80;
  const keyboardTop = chat.scrollTop;
  growing.style.height = '600px';
  await frames();
  check(near(chat.scrollTop, keyboardTop), 'Asynchronous growth overrode keyboard scrolling');
  growing.remove();
  fixtureWindow.chatLayoutChecks = [...copyChecks, 'Streaming respects small upward gestures and reading older text; returning to the end resumes following', 'Asynchronous content resizing follows only while the reader stays at the end'];

  render(`\`\`\`mermaid\n${longSequence}\n\`\`\``);
  await frames();
  const boundsCheck = () => {
    const svg = /** @type {SVGSVGElement} */ (host.querySelector('.mermaid-svg'));
    check(Boolean(svg), 'Sequence diagram did not render');
    const view = svg.viewBox.baseVal;
    const texts = [...svg.querySelectorAll('text')];
    for (const text of texts) {
      const box = text.getBBox();
      check(box.x >= view.x - 1 && box.x + box.width <= view.x + view.width + 1 && box.y >= view.y - 1 && box.y + box.height <= view.y + view.height + 1, `Clipped diagram label: ${text.textContent}`);
    }
    for (let i = 0; i < texts.length; i++) {
      const a = texts[i].getBBox();
      for (const other of texts.slice(i + 1)) {
        const b = other.getBBox();
        check(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y), `Overlapping labels: ${texts[i].textContent} / ${other.textContent}`);
      }
    }
    const participantText = [...svg.querySelectorAll('.mermaid-participant')].map(node => node.textContent);
    check(participantText.includes('Keystone API') && participantText.includes('Keystone Tools'), 'Multi-word participant names were truncated');
    check(svg.getBoundingClientRect().width <= svg.parentElement.clientWidth + 1, 'Diagram overflows the chat width');
  };
  for (const width of [420, 900, 1200]) { host.style.width = `${width}px`; await frames(); boundsCheck(); }
  document.documentElement.style.setProperty('--mono', 'serif');
  window.dispatchEvent(new Event('jolo:fonts'));
  await frames();
  boundsCheck();
  document.documentElement.style.setProperty('--mono', 'monospace');
  window.dispatchEvent(new Event('jolo:fonts'));
  await frames();
  boundsCheck();
  chat.scrollTop = 0;
  fixtureWindow.chatLayoutChecks.push('Long sequence diagrams keep complete participant names, wrapped labels, notes and self-messages aligned inside the canvas at narrow and wide widths and after font changes');
  fixtureWindow.chatLayoutResult = { ok: true, checks: fixtureWindow.chatLayoutChecks };
}
void run().catch(error => { fixtureWindow.chatLayoutResult = { ok: false, error: error.stack }; });
