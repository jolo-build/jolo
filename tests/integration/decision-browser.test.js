import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSER_OPERATIONS } from '@jolo/protocol';
import { startEngine, tempHome, removeHome, waitFor, openSession } from './helpers.js';

test.each([[0, 'openrouter', false], [1, 'openrouter', false], [2, 'openrouter', false], [0, 'typesafe', false], [0, 'typesafe', true]])('decision browser recovers from %i invalid responses via %s (web discovery: %s)', async (invalidReplies, transport, discovery) => {
  const home = tempHome(), requests = [], actions = [];
  let completionRejected = false;
  const model = { preset: 'decisions', model: 'any-vendor/browser-choice', mode: 'decision-browser', chatModel: { preset: 'openai', model: 'must-not-be-called' } };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'GET') return Response.json(transport === 'typesafe' ? { models: [{ name: model.model }] } : { data: [{ id: model.model, architecture: { output_modalities: ['decisions'] } }] });
    const body = await request.json(); requests.push({ path: new URL(request.url).pathname, body });
    if (body.questions.complete) {
      const complete = body.state.page.title === 'Submitted';
      if (!complete) completionRejected = true;
      return Response.json({ model: model.model, answers: { complete: { type: 'noul', noul: complete ? 1 : 0 } }, usage: { input_tokens: 20, output_tokens: 5 } });
    }
    if (body.questions.start) {
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const options = question.criteria;
        const choice = Object.keys(options).find(key => String(options[key]).endsWith(': coffee'));
        return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(options).map(key => [key, key === choice ? 1 : 0])) }];
      }));
      return Response.json({ model: model.model, answers, usage: { input_tokens: 20, output_tokens: 5 } });
    }
    const options = body.questions.action.criteria;
    const field = body.state.page.nodes.find(node => node.role === 'textbox');
    const id = body.state.page.url === 'about:blank' ? discovery ? 'web_search' : Object.keys(options).find(id => id.startsWith('navigate_'))
      : field?.value !== 'coffee' ? Object.keys(options).find(id => id.startsWith('fill_'))
      : discovery && !completionRejected ? 'done'
      : body.state.page.title !== 'Submitted' ? Object.keys(options).find(id => id.startsWith('click_')) : 'done';
    return Response.json({ model: model.model, answers: { action: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(options).map(key => [key, key === id ? requests.length <= invalidReplies ? 0.6 : 1 : 0])) } }, usage: { input_tokens: 20, output_tokens: 5 } });
  } });
  let engine, host, client;
  try {
    const dir = path.join(home, 'data/t/providers'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ id: 'decisions', displayName: 'Decision fixture', protocol: transport === 'typesafe' ? 'typesafe' : 'openai-chat', baseUrl: server.url.origin + '/api/v1', auth: { kind: 'none' }, listing: transport, defaults: { contextWindowTokens: 32000, maxOutputTokens: 4096 } }));
    engine = await startEngine({ home }); client = await engine.connect();
    const { project, session } = await openSession(client, home);
    await client.call('session.setModel', { sessionId: session.id, model, expectedRevision: session.revision });
    await client.call('settings.update', { budgets: { maxIterations: invalidReplies ? 20 : 1 } });
    host = await engine.connect({ clientKind: 'desktop' });
    let url = 'about:blank', title = '', value = '', revision = 1, snapshotSequence = 0;
    host.onNotification('browser.execute', async params => {
      const args = params.arguments; actions.push({ operation: params.operation, args });
      let result;
      if (params.operation === 'navigate') { url = args.url; title = 'Search'; revision++; result = { url, title, navigationRevision: revision }; }
      else if (params.operation === 'snapshot') result = { url, title, snapshotId: `snap_${++snapshotSequence}`, navigationRevision: revision, truncated: false, nodes: url === 'about:blank' ? [] : [
        { ref: 'e1', role: 'textbox', name: 'Search', value }, { ref: 'e2', role: 'button', name: 'Submit' },
      ] };
      else if (params.operation === 'fill') { value = args.text; result = { filled: true }; }
      else if (params.operation === 'click') { title = 'Submitted'; result = { clicked: true }; }
      else throw new Error(`Unexpected browser operation ${params.operation}`);
      await host.call('browser.result', { invocationId: params.invocationId, status: 'ok', result, ...(params.operation === 'navigate' ? { navigationRevision: revision } : {}) });
    });
    await host.call('browser.register', { workspaceId: project.workspaceId, tabId: 'tab_1', navigationRevision: revision, url, title, operations: [...BROWSER_OPERATIONS] });
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'direct-browser', prompt: discovery ? 'Find coffee.' : transport === 'typesafe' ? 'Open example.test and search coffee and click Submit.' : 'Open https://example.test/, enter "coffee" in Search and click Submit.' });
    const finish = () => waitFor(async () => {
      const snapshot = await client.call('run.snapshot', { runId: run.id });
      return ['completed', 'failed', 'paused'].includes(snapshot.run.state) ? snapshot : null;
    }, { timeoutMs: 15_000 });
    if (invalidReplies === 2) {
      const paused = await finish();
      expect(paused.run.state).toBe('paused');
      expect(paused.run.failure).toContain('invalid response twice');
      expect(actions.filter(action => action.operation !== 'snapshot')).toHaveLength(0);
      expect(requests).toHaveLength(2);
      await client.call('run.resume', { runId: run.id });
    }
    for (let index = 0; index < (invalidReplies ? 0 : discovery ? 4 : 3); index++) {
      const paused = await finish();
      expect(paused.run.state).toBe('paused'); expect(paused.run.pauseReason).toBe('budget');
      await client.call('run.resume', { runId: run.id });
    }
    const done = await finish();
    expect(done.run.state).toBe('completed');
    expect(actions.filter(action => action.operation !== 'snapshot').map(action => action.operation)).toEqual(['navigate', 'fill', 'click']);
    expect(actions.find(action => action.operation === 'fill').args.text).toBe('coffee');
    expect(actions.find(action => action.operation === 'navigate').args.url).toBe(discovery ? 'https://www.google.com/' : transport === 'typesafe' ? 'https://example.test' : 'https://example.test/');
    expect(actions.filter(action => action.operation !== 'snapshot').every(action => action.args.tabId === 'tab_1')).toBe(true);
    expect(requests).toHaveLength(5 + invalidReplies + (transport === 'typesafe' ? 1 : 0) + (discovery ? 2 : 0));
    if (discovery) expect(completionRejected).toBe(true);
    expect(requests.every(request => request.path === (transport === 'typesafe' ? '/api/v1/systemone' : '/api/alpha/decisions') && request.body.model === model.model)).toBe(true);
    expect(done.run.usage.inputTokens).toBe(100 + invalidReplies * 20 + (transport === 'typesafe' ? 20 : 0) + (discovery ? 40 : 0));
    const answer = done.messages.find(message => message.role === 'assistant');
    expect((await client.call('artifact.read', { artifactId: answer.artifactId })).text).toContain('Current page: Submitted');
  } finally { await host?.close(); await client?.close(); await engine?.stop(); server.stop(true); removeHome(home); }
}, 30_000);

test.each([false, true])('browser collection survives pauses and repeated reads/actions (%s), scrolls and follows pagination', async (repeatActions) => {
  const home = tempHome(), actions = [];
  const model = { preset: 'decisions', model: 'jev-fixture', mode: 'decision-browser' };
  let url = 'about:blank', expanded = false, revision = 1, sequence = 0, classified = 0;
  const names = () => url.endsWith('/2') ? ['Exhibitor A', 'Exhibitor D'] : expanded ? ['Exhibitor A', 'Exhibitor B', 'Exhibitor C'] : ['Exhibitor A', 'Exhibitor B'];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'GET') return Response.json({ data: [{ id: model.model, architecture: { output_modalities: ['decisions'] } }] });
    const body = await request.json();
    let answers;
    if (body.questions.action) {
      const options = body.questions.action.criteria, state = body.state;
      const next = state.page.nodes.find(node => node.name === 'Next');
      const choice = repeatActions && state.page.url !== 'about:blank'
        ? options.collect_text ? 'collect_text' : options.scroll_down ? 'scroll_down' : next && options[`click_${next.ref}`] ? `click_${next.ref}` : 'done'
        : state.page.url === 'about:blank' ? Object.keys(options).find(id => id.startsWith('navigate_'))
        : state.collection.count < names().filter(name => name !== 'Exhibitor A').length + 1 || state.collection.lastPageRead?.url !== url ? 'collect_text'
        : !expanded ? 'scroll_down' : next ? `click_${next.ref}` : 'done';
      answers = { action: { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(options).map(key => [key, key === choice ? 1 : 0])) } };
    } else {
      classified += body.state.candidates.length;
      answers = Object.fromEntries(body.state.candidates.map(candidate => [candidate.id, { type: 'noul', noul: candidate.text.startsWith('Exhibitor ') ? 1 : 0 }]));
    }
    return Response.json({ model: model.model, answers, usage: { input_tokens: 10, output_tokens: 5 } });
  } });
  let engine, client, host;
  try {
    const dir = path.join(home, 'data/t/providers'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ id: 'decisions', displayName: 'Decision fixture', protocol: 'openai-chat', baseUrl: server.url.origin + '/api/v1', auth: { kind: 'none' }, listing: 'openrouter', defaults: { contextWindowTokens: 32000, maxOutputTokens: 4096 } }));
    engine = await startEngine({ home }); client = await engine.connect();
    const { project, session } = await openSession(client, home);
    await client.call('session.setModel', { sessionId: session.id, model, expectedRevision: session.revision });
    await client.call('settings.update', { budgets: { maxIterations: 3 } });
    host = await engine.connect({ clientKind: 'desktop' });
    host.onNotification('browser.execute', async params => {
      actions.push(params.operation);
      if (params.operation === 'navigate') { url = params.arguments.url; revision++; }
      else if (params.operation === 'scroll') expanded = true;
      else if (params.operation === 'click') { url = 'https://example.test/2'; revision++; }
      const result = params.operation === 'snapshot' ? { url, title: 'Exhibitors', snapshotId: `s${++sequence}`, navigationRevision: revision, truncated: false, nodes: url === 'about:blank' ? [] : [
        ...names().map((name, index) => ({ ref: `e${index + 1}`, role: 'heading', name })),
        { ref: 'e10', role: 'StaticText', name: 'Unrelated footer' },
        ...(expanded && !url.endsWith('/2') ? [{ ref: 'e11', role: 'link', name: 'Next' }] : []),
      ] } : { url, navigationRevision: revision };
      await host.call('browser.result', { invocationId: params.invocationId, status: 'ok', result, ...(['navigate', 'click'].includes(params.operation) ? { navigationRevision: revision } : {}) });
    });
    await host.call('browser.register', { workspaceId: project.workspaceId, tabId: 'tab_1', navigationRevision: revision, url, title: '', operations: [...BROWSER_OPERATIONS] });
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'collect', prompt: 'Open https://example.test/ and list all exhibitors. Scroll and follow Next for more entries.' });
    const finish = () => waitFor(async () => {
      const value = await client.call('run.snapshot', { runId: run.id });
      return ['paused', 'failed', 'completed'].includes(value.run.state) ? value : null;
    }, { timeoutMs: 10_000 });
    const paused = await finish();
    expect(paused.run.state).toBe('paused');
    const partial = paused.messages.filter(message => message.role === 'assistant').at(-1);
    expect((await client.call('artifact.read', { artifactId: partial.artifactId })).text).toContain('Collected so far: 2');
    await client.call('settings.update', { budgets: { maxIterations: 30 } });
    await client.call('run.resume', { runId: run.id });
    const done = await finish();
    expect(done.run.state).toBe('completed');
    const answer = done.messages.filter(message => message.role === 'assistant').at(-1);
    const text = (await client.call('artifact.read', { artifactId: answer.artifactId })).text;
    expect(text).toContain('Collected entries: 4');
    for (const name of ['A', 'B', 'C', 'D']) expect(text.split(`- Exhibitor ${name}`).length - 1).toBe(1);
    expect(text).not.toContain('Unrelated footer');
    expect(actions).toContain('scroll'); expect(actions).toContain('click');
    expect(classified).toBe(8); // Three initial nodes, C + Next after scrolling, and three on page two; no repeated classification after resume.
  } finally { await host?.close(); await client?.close(); await engine?.stop(); server.stop(true); removeHome(home); }
}, 30_000);
