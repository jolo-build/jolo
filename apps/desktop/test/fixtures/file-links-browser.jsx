// Bundled only by the file-preview smoke suite, in an isolated browser window.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Markdown } from '../../src/renderer/components/markdown.jsx';
import { FilePreview } from '../../src/renderer/components/file-preview.jsx';
import { FilePreviewContext } from '../../src/renderer/file-preview-context.js';
import { reviewTable } from '../../../../packages/markdown/test/fixtures/review-table.js';

const fixtureWindow = /** @type {any} */ (window);
const pending = [], shown = [], released = [];
fixtureWindow.jolo = {
  previewChatFile: params => new Promise(resolve => pending.push({ params, resolve })),
  releaseChatFile: url => { released.push(url); return Promise.resolve(); },
};
const host = document.createElement('main');
document.body.append(host);
const root = createRoot(host);
const render = (sessionId, reference) => flushSync(() => root.render(<FilePreviewContext.Provider value={file => shown.push(file.url)}><Markdown sessionId={sessionId} text={`[File](${reference})`} cacheKey="fixture" /></FilePreviewContext.Provider>));
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const waitFor = async predicate => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for renderer update'); await tick(); } };
const click = () => host.querySelector('a').click();
const success = (index, url) => pending[index].resolve({ ok: true, result: { url } });
const failure = index => pending[index].resolve({ ok: false, code: 'FILE_NOT_FOUND', error: 'Fixture missing file' });

async function run() {
  render('a', 'first.png'); click();
  render('b', 'second.png');
  success(0, 'old-chat'); await tick();
  check(shown.length === 0 && released.includes('old-chat'), 'A late response crossed chats or leaked its preview');
  click(); render('b', 'third.png'); failure(1); await tick();
  check(!document.querySelector('.file-link-notice'), 'An old link failure appeared beside its replacement');
  click(); click();
  success(3, 'newest'); await tick(); success(2, 'older'); await tick();
  check(shown.join() === 'newest' && released.includes('older'), 'An older request replaced the latest preview');
  click(); failure(4); await waitFor(() => document.querySelector('.file-link-notice:popover-open'));
  check(Boolean(document.querySelector('.file-link-notice:popover-open')), 'File error notice did not open');
  check(!host.querySelector('.file-link-notice'), 'File error changed the Markdown content');
  /** @type {HTMLButtonElement} */ (document.querySelector('[aria-label="Dismiss file error"]')).click(); await tick();
  check(!document.querySelector('.file-link-notice'), 'Dismiss did not remove the error notice');
  click(); failure(5); await waitFor(() => document.querySelector('.file-link-notice:popover-open')); render('c', 'next.png'); await tick();
  check(!document.querySelector('.file-link-notice'), 'File error survived a chat change');
  for (const [line, column] of [[2, 1], [3, 50], [1, 2]]) {
    const text = 'one\n\nthree\n';
    flushSync(() => root.render(<FilePreview file={{ path: 'source.js', kind: 'text', text, line, column }} onClose={null} />));
    check(host.querySelector('code').closest('.file-heading') !== null, 'Source heading disappeared');
    check(host.querySelector('.file-preview-source code').textContent === text, 'Location highlighting changed copied source text');
  }
  host.className = 'message';
  host.style.margin = '24px';
  for (const width of [320, 720, 1100]) {
    host.style.width = `${width}px`;
    flushSync(() => root.render(<Markdown sessionId="table" text={reviewTable} cacheKey="table" />));
    await document.fonts.ready;
    const table = host.querySelector('table'), scroller = host.querySelector('.md-table-scroll');
    check(Array.from(table.rows).every(row => row.cells.length === 3), 'A code pipe created an extra table column');
    check(table.rows[6].cells[2].querySelector('code').textContent === '/exceed|limit/i', 'The regex lost its pipe or gained an escape');
    check(scroller.getBoundingClientRect().right <= host.getBoundingClientRect().right + 1, 'The table escaped its message');
    const word = table.rows[3].cells[1].firstChild;
    const range = document.createRange(); range.setStart(word, 0); range.setEnd(word, 'Confirmed'.length);
    check(range.getClientRects().length === 1, 'A table column split Confirmed in the middle of the word');
    check(!Array.from(table.querySelectorAll('a')).some(link => link.textContent === 'native.block'), 'The table linked a code property as a website');
  }
  host.style.width = '240px';
  flushSync(() => root.render(<Markdown text={`| Identifier |\n| --- |\n| \`${'longIdentifier'.repeat(20)}\` |`} cacheKey="wide-table" />));
  const scroller = host.querySelector('.md-table-scroll');
  check(scroller.scrollWidth > scroller.clientWidth, 'An oversized table has no horizontal scroll area');
  check(host.scrollWidth <= host.clientWidth + 1, 'An oversized table widened the message');
  scroller.scrollLeft = 100;
  check(scroller.scrollLeft > 0, 'The table cannot be scrolled horizontally');
  host.style.width = '900px';
  flushSync(() => root.render(<Markdown sessionId="table" text={reviewTable} cacheKey="table" />));
  return { ok: true, checks: ['late file responses cannot cross chats or replace newer requests', 'dismissible errors reset with their file and chat', 'source highlighting preserves copied text, including empty lines', 'Markdown tables preserve escaped code pipes and column counts, keep words intact, and scroll within narrow messages'] };
}
void run().then(result => { fixtureWindow.fileLinkResult = result; }, error => { fixtureWindow.fileLinkResult = { ok: false, error: error.stack }; });
