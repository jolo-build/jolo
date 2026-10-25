import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { automaticTitle } from '../src/storage/records.js';
import { RunService } from '../src/runs/service.js';
import { TITLE_INSTRUCTIONS, cheapestModel, createTitleService, titleFromAnswer } from '../src/titles.js';

const FAKE_CLAUDE = path.join(import.meta.dir, '..', '..', '..', 'tests', 'fixtures', 'fake-claude.js');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A real database in a temp dir, with one project and its folder. */
function storageFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-titles-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const events = [];
  storage.events.on('event', (event) => events.push(event));
  return {
    root, storage, events,
    chat: (fields = {}) => storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: '', ...fields }),
    titlesOf: (sessionId) => events.filter((event) => event.type === 'session.updated' && event.payload.session.id === sessionId).map((event) => event.payload.session.title),
    close() { storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/**
 * A provider factory in the shape the engine's has: `capture` resolves a session's model, `models` lists a preset,
 * `create` hands back a provider that streams `answer` once `gate` settles. Ids in `refuse` cannot be created.
 */
function fakeFactory({ answer = 'Counting to two hundred', gate = null, refuse = [], protocol = 'openai-responses', listing = 'openai', configured = true, stream = null, models = [{ id: 'acme-large' }, { id: 'acme-mini' }, { id: 'acme-nano' }] } = {}) {
  const created = [], requests = [], listed = [];
  return {
    created, requests, listed,
    capture: () => (configured ? { pending: true, ref: { preset: 'acme', model: 'acme-large', effort: 'high', contextWindowTokens: null, maxOutputTokens: null }, endpoint: { id: 'acme', protocol, listing } } : null),
    async models(preset) { listed.push(preset); return { models, note: null }; },
    async create(selection) {
      created.push(selection);
      if (refuse.includes(selection.model)) throw new Error(`${selection.model} reports no tool support; choose a model that can use tools`);
      return { configured: true, settings: selection, provider: { capabilities: () => ({ maxOutputTokens: 4096 }), stream: stream ?? async function* (request) {
        requests.push(request);
        await gate;
        yield { type: 'text_delta', itemId: 'title', text: answer };
        yield { type: 'finished', reason: 'completed' };
      } } };
    },
  };
}

/** A RunService over a real database whose runs finish at once, with every title suggestion it starts kept to await. */
function runFixture(deps = {}) {
  const f = storageFixture();
  const service = createTitleService({ storage: f.storage, log: quiet, env: {}, ...deps });
  const asked = [];
  const titles = service && { claims: (session, execution) => service.claims(session, execution), suggest: (session, prompt, execution) => { const promise = service.suggest(session, prompt, execution); asked.push(promise); return promise; } };
  const runs = new RunService({ storage: f.storage, log: quiet, titles, lifetime: { workStarted() {}, workFinished() {} }, executor: { execute: async () => ({ outcome: 'completed' }) } });
  let sequence = 0;
  return {
    ...f, service, runs, asked,
    /** The suggestions started so far, once the deferred ones have begun: RunService asks after the run is queued. */
    async settle() { await new Promise((resolve) => setTimeout(resolve, 0)); return Promise.all(asked); },
    start: (session, prompt, execution = undefined) => runs.start({ sessionId: session.id, requestId: `request-${sequence++}`, prompt, execution }).run,
    async close() { await runs.stopAll(); f.close(); },
  };
}

describe('the cheapest model an answerer has', () => {
  test('is the first one, in the order listed, whose id names a small tier', () => {
    expect(cheapestModel([{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'gpt-5-nano' }], 'gpt-5')).toEqual({ id: 'gpt-5-mini' });
    expect(cheapestModel([{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }], 'claude-sonnet-4-5')).toEqual({ id: 'claude-haiku-4-5' });
    expect(cheapestModel([{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash-lite' }, { id: 'gemini-2.5-flash' }], 'gemini-2.5-pro')).toEqual({ id: 'gemini-2.5-flash-lite' });
    expect(cheapestModel([{ id: 'default' }, { id: 'fable' }, { id: 'haiku' }], 'default')).toEqual({ id: 'haiku' });
    expect(cheapestModel([{ id: 'mistral-large-latest' }, { id: 'mistral-small-latest' }], 'mistral-large-latest')).toEqual({ id: 'mistral-small-latest' });
  });

  test('is the current model when no id names a small tier, a tier inside another word included', () => {
    expect(cheapestModel([{ id: 'gpt-5' }, { id: 'o3' }, { id: 'minimax-m2' }, { id: 'satellite-7b' }], 'o3')).toEqual({ id: 'o3' });
    expect(cheapestModel([], 'acme-large')).toEqual({ id: 'acme-large' });
  });

  test('never picks a speech, realtime, embedding, image or search variant', () => {
    const openai = [{ id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-mini-realtime-preview' }, { id: 'gpt-4o-mini-transcribe' }, { id: 'gpt-4o-mini-audio-preview' }, { id: 'gpt-4o-mini-search-preview' }, { id: 'gpt-4o-mini' }, { id: 'gpt-5-mini' }];
    expect(cheapestModel(openai, 'gpt-5')).toEqual({ id: 'gpt-4o-mini' });
    expect(cheapestModel([{ id: 'gemini-2.5-flash-image' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'omni-moderation-mini' }, { id: 'gemini-2.5-flash-lite' }], 'gemini-2.5-pro')).toEqual({ id: 'gemini-2.5-flash-lite' });
    expect(cheapestModel([{ id: 'gpt-5' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-realtime-mini' }, { id: 'phi-3-vision-mini' }], 'gpt-5')).toEqual({ id: 'gpt-5' });
  });

  test('passes over a large current model listed first, and keeps a small chat model the task is on, whatever is listed first', () => {
    expect(cheapestModel([{ id: 'acme-large' }, { id: 'acme-mini' }], 'acme-large')).toEqual({ id: 'acme-mini' });
    expect(cheapestModel([{ id: 'gpt-5-mini' }, { id: 'gpt-5-nano' }], 'gpt-5-mini')).toEqual({ id: 'gpt-5-mini' });
    expect(cheapestModel([{ id: 'gpt-5-mini' }, { id: 'gpt-5-nano' }], 'gpt-5-nano')).toEqual({ id: 'gpt-5-nano' });
    expect(cheapestModel([{ id: 'gpt-5-mini' }], 'gpt-4.1-nano')).toEqual({ id: 'gpt-4.1-nano' }); // not listed, still small
    expect(cheapestModel([{ id: 'gpt-5-mini' }], 'gpt-4o-mini-realtime-preview')).toEqual({ id: 'gpt-5-mini' }); // small, but it does not chat
  });
});

describe('a title from what the model answered', () => {
  test('loses its quotes, backticks, a leading Title: and a trailing period', () => {
    expect(titleFromAnswer('"Fix the login redirect"')).toBe('Fix the login redirect');
    expect(titleFromAnswer('“Fix the login redirect”')).toBe('Fix the login redirect');
    expect(titleFromAnswer('`Fix the login redirect`')).toBe('Fix the login redirect');
    expect(titleFromAnswer('Title: Fix the login redirect.')).toBe('Fix the login redirect');
    expect(titleFromAnswer('title: "Fix the login redirect."')).toBe('Fix the login redirect');
    expect(titleFromAnswer('Wait for it...')).toBe('Wait for it...');
  });

  test('is the first line that has words, its whitespace collapsed', () => {
    expect(titleFromAnswer('\n\n   Fix the   login\tredirect  \nThis title says what the message asks for.')).toBe('Fix the login redirect');
  });

  test('loses Markdown, and is the first line with words once that is gone', () => {
    expect(titleFromAnswer('**Fix login**')).toBe('Fix login');
    expect(titleFromAnswer('__Fix login__')).toBe('Fix login');
    expect(titleFromAnswer('*Fix login*')).toBe('Fix login');
    expect(titleFromAnswer('_Fix login_')).toBe('Fix login');
    expect(titleFromAnswer('# Fix login')).toBe('Fix login');
    expect(titleFromAnswer('## **Fix login**')).toBe('Fix login');
    expect(titleFromAnswer('- Fix login')).toBe('Fix login');
    expect(titleFromAnswer('* "Fix login"')).toBe('Fix login');
    expect(titleFromAnswer('**Title:** Fix login')).toBe('Fix login');
    expect(titleFromAnswer('Title:\nFix login')).toBe('Fix login');
    expect(titleFromAnswer('**\n# \nFix login')).toBe('Fix login');
    expect(titleFromAnswer('snake_case_names in the parser')).toBe('snake_case_names in the parser');
  });

  test('keeps quotes and backticks that do not wrap the whole title', () => {
    expect(titleFromAnswer('"Fix" vs "Break"')).toBe('"Fix" vs "Break"');
    expect(titleFromAnswer('`foo` and `bar`')).toBe('`foo` and `bar`');
    expect(titleFromAnswer("'Fix the user's login'")).toBe("'Fix the user's login'");
    expect(titleFromAnswer('"Fix login`')).toBe('"Fix login`');
  });

  test('is cut at 80 characters on a word boundary', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const title = titleFromAnswer(long);
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    expect(long.startsWith(`${title} `)).toBe(true);
    expect(titleFromAnswer('x'.repeat(200))).toBe('x'.repeat(80));
  });

  test('is cut hard at 80 when the last space comes before the halfway mark, as in Chinese or Japanese', () => {
    const cjk = `修复 ${'登录页面的重定向问题'.repeat(10)}`;
    expect(titleFromAnswer(cjk)).toBe(Array.from(cjk).slice(0, 80).join(''));
    const late = `${'a'.repeat(50)} ${'b'.repeat(50)}`;
    expect(titleFromAnswer(late)).toBe('a'.repeat(50));
  });

  test('is null when nothing is left', () => {
    for (const answer of ['', '   \n  ', '""', '``', 'Title:', '.', null, undefined]) expect(titleFromAnswer(answer)).toBeNull();
  });
});

describe('a suggested title is written only on a blank title', () => {
  test('it is written, with session.updated, while the title is blank; the prefix is written only while blank too', () => {
    const f = storageFixture();
    try {
      const session = f.chat();
      const before = f.storage.getSession(session.id);
      f.events.length = 0;
      expect(f.storage.replaceBlankTitle(session.id, 'Counting to 200')).toBe(true);
      expect(f.storage.getSession(session.id)).toMatchObject({ title: 'Counting to 200', revision: before.revision + 1 });
      expect(f.titlesOf(session.id)).toEqual(['Counting to 200']);
      expect(f.storage.replaceBlankTitle(session.id, 'Counting again')).toBe(false);
      const prompt = '  Count from 1 to 200\n slowly  ';
      expect(automaticTitle(prompt)).toBe('Count from 1 to 200 slowly');
      expect(f.storage.assignSessionTitle(session.id, prompt)).toBe(false);
      const other = f.chat();
      expect(f.storage.assignSessionTitle(other.id, '   ')).toBe(false);
      expect(f.storage.assignSessionTitle(other.id, prompt)).toBe(true);
      expect(f.storage.getSession(other.id).title).toBe('Count from 1 to 200 slowly');
    } finally { f.close(); }
  });

  test('the title and its session.updated commit together', () => {
    const f = storageFixture();
    try {
      const session = f.chat();
      const append = f.storage.appendEvent;
      f.storage.appendEvent = () => { throw new Error('event refused'); };
      try { expect(() => f.storage.replaceBlankTitle(session.id, 'Counting to 200')).toThrow('event refused'); }
      finally { f.storage.appendEvent = append; }
      expect(f.storage.getSession(session.id).title).toBe('');
    } finally { f.close(); }
  });

  test('a rename by the person wins, and a deleted session is left alone', () => {
    const f = storageFixture();
    try {
      const session = f.chat();
      f.storage.updateSession(session.id, { title: 'My counting task' });
      f.events.length = 0;
      expect(f.storage.replaceBlankTitle(session.id, 'Counting to 200')).toBe(false);
      expect(f.storage.getSession(session.id).title).toBe('My counting task');
      const gone = f.chat();
      f.storage.updateSession(gone.id, { deleted: true });
      f.events.length = 0;
      expect(f.storage.replaceBlankTitle(gone.id, 'Counting to 200')).toBe(false);
      expect(f.storage.db.query('SELECT title FROM sessions WHERE id = ?1').get(gone.id).title).toBe(''); // getSession hides it
      expect(f.events).toEqual([]);
    } finally { f.close(); }
  });
});

describe('whether the service will name a task', () => {
  const claude = { get: (id) => ({ id, displayName: id, transport: id === 'claude' ? 'claude-stream' : 'codex-app-server' }) };
  test('yes for a configured provider and for Claude Code; no for the demo provider, a local Ollama listing, no provider, Codex or an unknown agent', () => {
    const f = storageFixture();
    try {
      const chat = f.chat(), claudeChat = f.chat({ agentId: 'claude' }), codexChat = f.chat({ agentId: 'codex' });
      const claims = (providerFactory, session = chat, catalog = claude) => createTitleService({ storage: f.storage, log: quiet, env: {}, providerFactory, catalog }).claims(session);
      expect(claims(fakeFactory())).toBe(true);
      expect(claims(fakeFactory(), claudeChat)).toBe(true);
      expect(claims(fakeFactory({ protocol: 'fake' }))).toBe(false);
      expect(claims(fakeFactory({ protocol: 'openai-chat', listing: 'ollama' }))).toBe(false);
      expect(claims(fakeFactory({ configured: false }))).toBe(false);
      expect(claims(fakeFactory(), codexChat)).toBe(false);
      expect(claims(fakeFactory(), f.chat({ agentId: 'gone' }), { get: () => { throw new Error('no manifest for agent gone'); } })).toBe(false);
      expect(claims({ capture: () => { throw new Error('bad settings'); } })).toBe(false);
    } finally { f.close(); }
  });

  test('asks whoever answers the first run, not the conversation\'s default: a model or agent chosen for the run decides', () => {
    const f = storageFixture();
    try {
      const chat = f.chat(), claudeChat = f.chat({ agentId: 'claude' });
      const local = fakeFactory({ protocol: 'openai-chat', listing: 'ollama' }), cloud = fakeFactory();
      // The default is a cloud provider; a run on a local preset is answered there, and so is never named by the cloud.
      const providerFactory = { ...cloud, capture: (session, execution) => (execution?.preset === 'local' ? local : cloud).capture() };
      const service = createTitleService({ storage: f.storage, log: quiet, env: {}, providerFactory, catalog: claude });
      expect(service.claims(chat)).toBe(true);
      expect(service.claims(chat, { preset: 'local', agentId: null, model: 'llama', effort: null })).toBe(false);
      // An agent picked for the run answers it: Codex is not asked, Claude Code is, and a preset picked for a Claude chat is Jolo's.
      expect(service.claims(chat, { agentId: 'codex', model: null, effort: null })).toBe(false);
      expect(service.claims(chat, { agentId: 'claude', model: null, effort: null })).toBe(true);
      expect(service.claims(claudeChat, { preset: 'local', agentId: null, model: 'llama', effort: null })).toBe(false);
      expect(service.claims(claudeChat, { agentId: 'jolo', model: null, effort: null })).toBe(true);
    } finally { f.close(); }
  });
});

describe('a first run on another answerer than the default', () => {
  test('is named after its prompt at once when that answerer is not asked, and the default provider is never sent the prompt', async () => {
    const cloud = fakeFactory(), local = fakeFactory({ protocol: 'openai-chat', listing: 'ollama' });
    const captured = [];
    const providerFactory = { ...cloud, capture: (session, execution) => { captured.push(execution?.preset ?? null); return (execution?.preset === 'local' ? local : cloud).capture(); } };
    const f = runFixture({ providerFactory });
    try {
      const session = f.chat();
      f.start(session, 'Summarize the build log', { preset: 'local', agentId: null, model: 'llama', effort: null });
      await f.settle();
      expect(f.asked).toHaveLength(0);
      expect(f.storage.getSession(session.id).title).toBe('Summarize the build log');
      expect(captured.every((preset) => preset === 'local')).toBe(true);
      expect(cloud.created).toEqual([]);
    } finally { await f.close(); }
  });
});

describe('a chat Jolo answers is named by its provider\'s cheapest model', () => {
  test('the first run writes no prefix; the title lands on the blank title with one request to the small model, and the second run asks nothing', async () => {
    const providerFactory = fakeFactory({ answer: 'Title: "Counting to two hundred."' });
    const f = runFixture({ providerFactory });
    try {
      const session = f.chat();
      const prompt = '  Count from 1 to 200 slowly, one number per line  ';
      f.start(session, prompt);
      expect(f.storage.getSession(session.id).title).toBe(''); // being named: no prefix in the meantime
      expect(f.titlesOf(session.id)).toEqual([]);
      expect(f.asked).toHaveLength(0); // asked once the run is queued, not inside start
      await f.settle();
      expect(f.asked).toHaveLength(1);
      expect(f.storage.getSession(session.id).title).toBe('Counting to two hundred');
      expect(f.titlesOf(session.id)).toEqual(['Counting to two hundred']); // one session.updated, with the title
      expect(providerFactory.listed).toEqual(['acme']);
      expect(providerFactory.created).toEqual([{ preset: 'acme', model: 'acme-mini', effort: null }]); // it lists no efforts: none chosen, as a plain run
      expect(providerFactory.requests).toEqual([{ sessionId: session.id, runId: null, purpose: 'title', instructions: TITLE_INSTRUCTIONS, items: [{ kind: 'user_message', groupId: 'title', payload: { text: prompt.trim() } }], tools: [], maxOutputTokens: 1024 }]);
      f.start(session, 'now count backwards');
      await f.settle();
      expect(f.asked).toHaveLength(1);
      expect(providerFactory.created).toHaveLength(1);
      expect(f.storage.getSession(session.id).title).toBe('Counting to two hundred');
    } finally { await f.close(); }
  });

  test('sends at most 4,000 characters of the first prompt', async () => {
    const providerFactory = fakeFactory();
    const f = runFixture({ providerFactory });
    try {
      f.start(f.chat(), `   ${'a'.repeat(5000)}`);
      await f.settle();
      expect(providerFactory.requests[0].items[0].payload.text).toBe('a'.repeat(4000));
    } finally { await f.close(); }
  });

  test('the model is made with the least thought it lists: minimal, then low, then the lowest; no effort when it lists none or thinks on a budget', async () => {
    const adaptive = { thinkingMode: 'adaptive' };
    /** @type {[Record<string, unknown>, string | null][]} */
    const cases = [
      [{ ...adaptive, efforts: ['minimal', 'low', 'medium'] }, 'minimal'],
      [{ ...adaptive, efforts: ['high', 'medium', 'low'] }, 'low'],
      [{ ...adaptive, efforts: ['max', 'high', 'medium'] }, 'medium'],
      [{ ...adaptive, efforts: ['none'] }, null],
      [{ ...adaptive, efforts: [] }, null],
      [{}, null],
      [{ efforts: ['low', 'medium', 'high'] }, null], // a budgeted thought needs more output than a title is given
    ];
    for (const [listing, effort] of cases) {
      const providerFactory = fakeFactory({ models: [{ id: 'acme-large', ...adaptive, efforts: ['low', 'high'] }, { id: 'acme-mini', ...listing }] });
      const f = runFixture({ providerFactory });
      try {
        f.start(f.chat(), 'Count from 1 to 200 slowly');
        await f.settle();
        expect(providerFactory.created).toEqual([{ preset: 'acme', model: 'acme-mini', effort }]);
      } finally { await f.close(); }
    }
  });

  test('a rename made while the title is on its way is kept', async () => {
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const providerFactory = fakeFactory({ gate: new Promise((resolve) => { release = resolve; }) });
    const f = runFixture({ providerFactory });
    try {
      const session = f.chat();
      f.start(session, 'Count from 1 to 200 slowly');
      expect(f.storage.getSession(session.id).title).toBe('');
      await new Promise((resolve) => setTimeout(resolve, 0)); // the suggestion is under way
      f.storage.updateSession(session.id, { title: 'My own name' });
      release();
      expect(await f.settle()).toEqual([null]);
      expect(providerFactory.requests).toHaveLength(1);
      expect(f.storage.getSession(session.id).title).toBe('My own name');
      // A rename before the suggestion begins asks nothing at all.
      const early = f.chat();
      f.start(early, 'Count from 1 to 200 slowly');
      f.storage.updateSession(early.id, { title: 'Named first' });
      await f.settle();
      expect(providerFactory.requests).toHaveLength(1);
      expect(f.storage.getSession(early.id).title).toBe('Named first');
    } finally { await f.close(); }
  });

  test('a second prompt while the first is being named writes no prefix of its own, and asks nothing more', async () => {
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const providerFactory = fakeFactory({ gate: new Promise((resolve) => { release = resolve; }) });
    const f = runFixture({ providerFactory });
    try {
      const session = f.chat();
      f.start(session, 'Count from 1 to 200 slowly');
      await new Promise((resolve) => setTimeout(resolve, 0)); // the first suggestion is under way
      f.start(session, 'and then backwards');
      expect(f.storage.getSession(session.id).title).toBe('');
      await new Promise((resolve) => setTimeout(resolve, 0)); // the second suggestion has started too, while the first still waits
      release();
      expect(await f.settle()).toEqual(['Counting to two hundred', null]);
      expect(providerFactory.created).toHaveLength(1);
      expect(f.storage.getSession(session.id).title).toBe('Counting to two hundred');
      expect(f.titlesOf(session.id)).toEqual(['Counting to two hundred']);
    } finally { await f.close(); }
  });

  test('a small model that cannot be made falls back to the chat\'s own; when that fails too, the prefix is the title', async () => {
    const fallback = fakeFactory({ refuse: ['acme-mini'], models: [{ id: 'acme-large', thinkingMode: 'adaptive', efforts: ['high', 'low'] }, { id: 'acme-mini', thinkingMode: 'adaptive', efforts: ['minimal'] }] });
    const f = runFixture({ providerFactory: fallback });
    try {
      const session = f.chat();
      f.start(session, 'Count from 1 to 200 slowly');
      await f.settle();
      expect(fallback.created.map((selection) => [selection.model, selection.effort])).toEqual([['acme-mini', 'minimal'], ['acme-large', 'low']]);
      expect(fallback.created[1]).toMatchObject({ preset: 'acme', model: 'acme-large', effort: 'low' });
      expect(f.storage.getSession(session.id).title).toBe('Counting to two hundred');
    } finally { await f.close(); }
    const refused = fakeFactory({ refuse: ['acme-mini', 'acme-large'] });
    const g = runFixture({ providerFactory: refused });
    try {
      const session = g.chat();
      const run = g.start(session, 'Count from 1 to 200 slowly');
      expect(g.storage.getSession(session.id).title).toBe('');
      expect(await g.settle()).toEqual([null]);
      expect(refused.created).toHaveLength(2);
      expect(g.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly');
      await Bun.sleep(0);
      expect(g.storage.getRun(run.id).state).toBe('completed');
    } finally { await g.close(); }
  });

  test('an answer that never ends is given up when the time runs out, and the prefix is the title', async () => {
    const providerFactory = fakeFactory({ stream: async function* (_request, signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'text_delta', itemId: 'title', text: 'Too late' };
    } });
    const f = runFixture({ providerFactory, timeoutMs: 50 });
    try {
      const session = f.chat();
      f.start(session, 'Count from 1 to 200 slowly');
      expect(await f.settle()).toEqual([null]);
      expect(f.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly');
    } finally { await f.close(); }
  });

  test('the title is asked for once the run is queued and started, never ahead of it', async () => {
    const f = storageFixture();
    const order = [];
    const titles = { claims: () => true, suggest: async () => { order.push('title asked'); return null; } };
    const runs = new RunService({ storage: f.storage, log: quiet, titles, lifetime: { workStarted() {}, workFinished() {} }, executor: { execute: async () => { order.push('run started'); return { outcome: 'completed' }; } } });
    try {
      runs.start({ sessionId: f.chat().id, requestId: 'first', prompt: 'Count from 1 to 200 slowly' });
      expect(order).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual(['run started', 'title asked']);
    } finally { await runs.stopAll(); f.close(); }
  });

  test('a local model server (an Ollama listing) is not asked: it would hold up the task\'s own first request', async () => {
    const providerFactory = fakeFactory({ protocol: 'openai-chat', listing: 'ollama' });
    const f = runFixture({ providerFactory });
    try {
      const session = f.chat();
      f.start(session, 'Count from 1 to 200 slowly');
      expect(f.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly'); // not claimed: the prefix at once
      expect(await f.settle()).toEqual([]);
      expect([providerFactory.listed, providerFactory.created]).toEqual([[], []]);
      expect(f.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly');
    } finally { await f.close(); }
  });

  test('the demo provider, an unconfigured engine and answerers other than Claude are not asked: the prefix at once, as before', async () => {
    for (const providerFactory of [fakeFactory({ protocol: 'fake' }), fakeFactory({ configured: false })]) {
      const f = runFixture({ providerFactory });
      try {
        const session = f.chat();
        f.start(session, 'Count from 1 to 200 slowly');
        expect(f.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly');
        expect(await f.settle()).toEqual([]);
        expect(providerFactory.created).toEqual([]);
      } finally { await f.close(); }
    }
    const providerFactory = fakeFactory();
    const listed = [], commands = [];
    const agentModels = { list: async (agentId) => { listed.push(agentId); return { agentId, models: [{ id: 'gpt-5.1-codex-mini' }], note: null }; } };
    const catalog = { get: (id) => ({ id, displayName: 'Codex', transport: 'codex-app-server' }), command: (manifest) => { commands.push(manifest.id); return ['codex']; } };
    const f = runFixture({ providerFactory, agentModels, catalog });
    try {
      const session = f.chat({ agentId: 'codex' });
      f.start(session, 'Count from 1 to 200 slowly');
      expect(f.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly');
      expect(await f.settle()).toEqual([]);
      expect(providerFactory.created).toEqual([]);
      expect([listed, commands]).toEqual([[], []]);
      expect(f.storage.getSession(session.id).title).toBe('Count from 1 to 200 slowly');
    } finally { await f.close(); }
  });

  test('JOLO_AUTO_TITLE=0 or off turns the service off', () => {
    for (const value of ['0', 'off', 'OFF']) expect(createTitleService({ storage: null, log: quiet, env: { JOLO_AUTO_TITLE: value } })).toBeNull();
    for (const value of [undefined, '1', 'on']) expect(createTitleService({ storage: null, log: quiet, env: { JOLO_AUTO_TITLE: value } })).not.toBeNull();
  });
});

describe('a chat Claude Code answers is named by one Claude process on its cheapest model', () => {
  /**
   * A `claude` that records its argv, the guardian grace it was given and what its stdin held as JSON, then hands that
   * stdin to `body` (default: the protocol fixture). Reading stdin to its end blocks until it is closed, as Claude's own
   * read waits.
   */
  function launcherIn(dir, body = null) {
    const file = path.join(dir, 'claude');
    const log = path.join(dir, 'launch.json');
    const record = `"${process.execPath}" -e 'const fs = require("node:fs"); const stdin = fs.readFileSync(0, "utf8"); fs.writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), grace: process.env.JOLO_GUARDIAN_EOF_GRACE_MS ?? null, stdin })); process.stdout.write(stdin)' "${log}" "$@"`;
    writeFileSync(file, `#!/bin/sh\n${record} | ${body ?? `"${process.execPath}" "${FAKE_CLAUDE}" "$@"`}\n`);
    chmodSync(file, 0o755);
    const launch = () => JSON.parse(readFileSync(log, 'utf8'));
    return { file, argv: () => launch().argv, launch };
  }
  /** `chosen` is the model Claude is set to run with; without one there is nothing to list. */
  const deps = (launcher, { models = [{ id: 'default' }, { id: 'fable' }, { id: 'haiku' }], chosen = null } = {}) => {
    const commands = [], listed = [];
    return {
      commands, listed,
      providerFactory: fakeFactory(),
      supervisor: { hostedEnvironment: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() }) },
      agentModels: { list: async (agentId) => { listed.push(agentId); return { agentId, models, note: null }; } },
      catalog: { get: (id) => ({ id, displayName: 'Claude Code', transport: 'claude-stream' }), config: () => ({ model: chosen }), command: (_manifest, override) => { commands.push(override); return [launcher.file, '--settings', '{}']; } },
    };
  };

  test('the prompt goes to the small model Claude lists in one print-mode process, and its result becomes the title', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jolo-titles-claude-'));
    const launcher = launcherIn(dir);
    const d = deps(launcher, { chosen: 'fable' });
    const f = runFixture(d);
    try {
      const session = f.chat({ agentId: 'claude' });
      f.start(session, '  summarise the release notes for me  ');
      expect(f.storage.getSession(session.id).title).toBe('');
      expect(await f.settle()).toEqual(['Fixture title: summarise the release']);
      expect(f.storage.getSession(session.id).title).toBe('Fixture title: summarise the release');
      expect(d.listed).toEqual(['claude']);
      expect(d.commands).toEqual([{ model: null, effort: null, fast: null }]);
      expect(launcher.argv()).toEqual(['--settings', '{}', '--print', '--output-format', 'json', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--max-turns', '1', '--system-prompt', TITLE_INSTRUCTIONS]); // the prompt is not on the command line, where ps would show it
      // Stdin is closed at once, so Claude does not wait for input, and the guardian leaves it the rest of the deadline.
      const { grace, stdin } = launcher.launch();
      expect(stdin).toBe('summarise the release notes for me'); // on stdin, which is closed after it
      expect(Number(grace)).toBeGreaterThan(0);
      expect(Number(grace)).toBeLessThanOrEqual(20_000);
      expect(d.providerFactory.created).toEqual([]);
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);

  test('a result that is an error, such as a sign-in Claude cannot use, leaves the prefix as the title', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jolo-titles-claude-'));
    const launcher = launcherIn(dir, `{ cat >/dev/null; echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'; }`); // reads its prompt first, as Claude does
    const d = deps(launcher, { models: [] });
    const f = runFixture(d);
    try {
      const session = f.chat({ agentId: 'claude' });
      f.start(session, 'summarise the release notes for me');
      expect(await f.settle()).toEqual([null]);
      expect(launcher.argv()).toContain('haiku'); // no model chosen: the alias, without asking for the list
      expect(d.listed).toEqual([]);
      expect(f.storage.getSession(session.id).title).toBe('summarise the release notes for me');
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);
});
