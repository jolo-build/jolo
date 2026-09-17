import { ProtocolError, TERMINAL_RUN_STATES } from '@jolo/protocol';
import { modelMentions, modelMentionSelector } from '@jolo/protocol/model-mentions';
import { newId, now } from '../storage/records.js';

const MAX_MODELS = 16, MAX_CHILDREN = 16, MAX_ACTIVE = 4;
const ended = run => !run || TERMINAL_RUN_STATES.includes(run.state) || run.state === 'paused';

/** Only user submissions can register models. Agent tools receive aliases and cannot invent providers. */
export function createDelegationService({ storage, runs, catalog, agentModels, providerFactory }) {
  const repository = storage.delegations;
  async function models(source = null) {
    const presets = source?.startsWith('agent:') ? [] : (await providerFactory.presets()).presets;
    const sources = [
      ...catalog.list().filter(a => a.available && a.transport !== 'pty' && a.supportsModel).map(a => ({ id: `agent:${a.id}`, name: a.displayName, load: () => agentModels.list(a.id) })),
      ...presets.filter(p => p.available).map(p => ({ id: `provider:${p.id}`, name: p.displayName, load: () => providerFactory.models(p.id, {}) })),
    ].filter(item => !source || item.id === source);
    const reports = await Promise.allSettled(sources.map(item => item.load()));
    const choices = [], notes = [];
    reports.forEach((report, i) => {
      const entry = sources[i];
      if (report.status === 'rejected') { notes.push(`${entry.name}: ${report.reason.message}`); return; }
      if (report.value.note) notes.push(`${entry.name}: ${report.value.note}`);
      for (const model of report.value.models) {
        if (model.supportsTools === false) continue;
        choices.push({ source: entry.id, sourceName: entry.name, model: model.id, name: model.displayName || model.id,
          efforts: model.efforts ?? report.value.efforts ?? [] });
      }
    });
    return { models: choices.slice(0, 1000), notes };
  }
  async function resolve(selector) {
    const slash = selector.indexOf('/'), source = selector.slice(0, slash);
    const report = await models(source);
    for (const model of report.models) {
      for (const effort of [null, ...model.efforts]) {
        if (modelMentionSelector(source, model.model, effort) !== selector) continue;
        const provider = source.startsWith('provider:');
        return { selector, name: `${model.name} · ${model.sourceName}${effort ? ` · ${effort}` : ''}`,
          execution: { agentId: provider ? 'jolo' : source.slice(6), preset: provider ? source.slice(9) : null, model: model.model, effort, pinned: true } };
      }
    }
    throw new ProtocolError('unavailable', `The selected model ^${selector} is unavailable. Select an available model with ^; no substitute was started.`);
  }
  function parentRun(runId) {
    const run = storage.getRun(runId);
    if (!run || ended(run) || run.state === 'cancelling') throw new ProtocolError('conflict', 'The parent run is no longer working');
    if (repository.parent(runId)) throw new ProtocolError('permission_denied', 'A delegated task cannot create more child tasks');
    return run;
  }
  function view(row, includeOutput = false) {
    const run = storage.getRun(row.childRunId), session = run && storage.getSession(run.sessionId);
    const result = { id: row.id, parentRunId: row.parentRunId, runId: row.childRunId, sessionId: run?.sessionId ?? '',
      title: session?.title ?? 'Deleted task', modelAlias: row.modelAlias, state: run?.state ?? 'interrupted',
      failure: run?.failure ?? null, execution: run?.execution ?? null, createdAt: row.createdAt, output: '', truncated: false };
    if (includeOutput && run && ended(run)) {
      // The final text is the child result; tool transcripts remain in the child's own conversation.
      const message = storage.listMessagesForRun(run.id).filter(m => m.role === 'assistant' && m.kind === 'text' && m.committedBytes > 0).at(-1);
      if (message) {
        const artifact = storage.getArtifact(message.artifactId);
        if (artifact) {
          const length = Math.min(message.committedBytes, 32 * 1024);
          result.output = storage.readArtifact(artifact, 0, length).buffer.toString('utf8').replace(/\uFFFD$/, '');
          result.truncated = message.committedBytes > length;
        }
      }
    }
    return result;
  }
  function scopedRow(runId, id) {
    const run = storage.getRun(runId);
    const row = run && repository.rows(run.sessionId, { id })[0];
    if (!row) throw new ProtocolError('not_found', 'Unknown delegated task in this conversation');
    return row;
  }
  function cancelChildren(run) {
    if (!['cancelled', 'failed', 'interrupted', 'paused'].includes(run.state)) return;
    for (const row of repository.rows(run.sessionId, { parentRunId: run.id })) {
      const child = storage.getRun(row.childRunId);
      if (child && !TERMINAL_RUN_STATES.includes(child.state) && child.state !== 'cancelling') runs.cancel({ runId: child.id });
    }
  }
  runs.settled.on('run', cancelChildren);
  // Cancellation propagates immediately, while the parent executor is still unwinding.
  const onEvent = event => {
    if (event.type === 'run.state' && event.payload.state === 'cancelling') {
      const run = storage.getRun(event.runId);
      if (run) cancelChildren({ ...run, state: 'cancelled' });
    }
  };
  storage.events.on('event', onEvent);
  return {
    models,
    /** Validate asynchronously, then persist together with run admission to avoid orphaned authorizations. */
    async prepare(prompt) {
      const selectors = [...new Set(modelMentions(prompt).map(m => m.selector))];
      if (selectors.length > MAX_MODELS) throw new ProtocolError('limit_exceeded', `Select at most ${MAX_MODELS} delegation models`);
      return Promise.all(selectors.map(resolve));
    },
    register(sessionId, choices) {
      const existing = repository.models(sessionId);
      for (const choice of choices) {
        if (existing.some(m => m.selector === choice.selector)) continue;
        if (existing.length >= MAX_MODELS) throw new ProtocolError('limit_exceeded', `This conversation already has ${MAX_MODELS} delegation models`);
        const model = { ...choice, alias: `m${existing.length + 1}` };
        repository.addModel(sessionId, model); existing.push(model);
      }
    },
    listModels(runId) {
      const run = storage.getRun(runId);
      if (!run) throw new ProtocolError('not_found', 'Unknown run');
      return { models: repository.models(run.sessionId) };
    },
    list(sessionId) { return { delegations: repository.rows(sessionId).map(row => view(row)) }; },
    async start(runId, { modelAlias, prompt, title, requestId }) {
      let parent = parentRun(runId);
      const previous = repository.rows(parent.sessionId, { parentRunId: runId }).find(row => row.requestId === requestId);
      if (previous) return { delegation: view(previous, true) };
      const model = repository.models(parent.sessionId).find(m => m.alias === modelAlias);
      if (!model) throw new ProtocolError('permission_denied', 'Choose an alias from delegation_models; ask the user to select a model with ^ if none are available');
      await resolve(model.selector); // Check installation/credentials/model support again before spending anything.
      parent = parentRun(runId);
      return storage.transaction(() => {
        const children = repository.rows(parent.sessionId, { parentRunId: runId });
        const duplicate = children.find(row => row.requestId === requestId);
        if (duplicate) return { delegation: view(duplicate, true) };
        if (children.length >= MAX_CHILDREN || children.filter(row => !ended(storage.getRun(row.childRunId))).length >= MAX_ACTIVE)
          throw new ProtocolError('limit_exceeded', `A turn supports ${MAX_ACTIVE} active child tasks and ${MAX_CHILDREN} total`);
        const owner = storage.getSession(parent.sessionId);
        if (!owner || owner.state !== 'open') throw new ProtocolError('conflict', 'The parent task is unavailable');
        const session = storage.createSession({ projectId: owner.projectId, workspaceId: owner.workspaceId, title: title || prompt.slice(0, 80),
          agentId: model.execution.agentId === 'jolo' ? null : model.execution.agentId });
        storage.appendEvent({ sessionId: session.id, type: 'session.created', payload: { session } });
        const { run } = runs.start({ sessionId: session.id, requestId: newId('req'), prompt, execution: model.execution });
        const row = { id: newId('del'), parentRunId: runId, childRunId: run.id, requestId, modelAlias, createdAt: now() };
        repository.insert(row);
        return { delegation: view(row) };
      });
    },
    async status(runId, { delegationId, waitMs = 0 }) {
      const row = scopedRow(runId, delegationId);
      if (waitMs && !ended(storage.getRun(row.childRunId))) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); runs.settled.removeListener('run', settled); resolve(null); };
        const settled = run => { if (run.id === row.childRunId || run.id === runId) done(); };
        const timer = setTimeout(done, Math.min(waitMs, 25_000));
        runs.settled.on('run', settled);
      });
      return { delegation: view(row, true) };
    },
    cancel(runId, delegationId) {
      const row = scopedRow(runId, delegationId), child = storage.getRun(row.childRunId);
      if (child && !TERMINAL_RUN_STATES.includes(child.state)) runs.cancel({ runId: child.id });
      return { delegation: view(row, true) };
    },
    close() { runs.settled.removeListener('run', cancelChildren); storage.events.removeListener('event', onEvent); },
  };
}

export function delegationInstructions(storage, run) {
  const models = storage.delegations?.models(run.sessionId) ?? [];
  if (!models.length) return '';
  return `The user selected these models for child-task delegation in this conversation:\n${models.map(m => `${m.alias}: ${m.name} (^${m.selector})`).join('\n')}\nUse Jolo's delegate_task with modelAlias and a unique requestId to start a child on the selected model. Supply a self-contained prompt with the relevant context; the child shares the workspace but has its own conversation. Use delegation_status with waitMs to collect its result, then summarize the result for the user. Do not substitute a vendor-native subagent or invent a model. A mention makes the model available; follow the user's request about whether to delegate. Children cannot delegate again. Stop children you no longer need with delegation_cancel.`;
}
