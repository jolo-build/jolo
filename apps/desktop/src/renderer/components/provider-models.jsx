import { modelLabel } from '../model-options.js';
import { useEffect, useRef, useState } from 'react';
// The schemas subpath, not the package root: the root also re-exports the socket framing, which is
// Node transport code the renderer never calls and must not carry into the browser bundle.
import { modelFromFields, ProviderOverridesSchema, modelChatIssue } from '@jolo/protocol/schemas';
import { Select } from './select.jsx';

export function ProviderModels({ settings, session, onPresets, onDiscover, onSaveConnection, onSaveDefault, onUseModel, onSetCredential }) {
  const current = session?.model ?? settings?.model;
  const [presets, setPresets] = useState([]), [selected, setSelected] = useState(current?.preset ?? 'openai');
  const [form, setForm] = useState({ model: current?.model ?? '', reasoningEffort: current?.effort ?? '', contextWindowTokens: current?.contextWindowTokens ?? '', maxOutputTokens: current?.maxOutputTokens ?? '' });
  const [baseUrl, setBaseUrl] = useState(settings?.providers?.[selected]?.baseUrl ?? '');
  const [key, setKey] = useState(''), [report, setReport] = useState(null), [busy, setBusy] = useState(false), [note, setNote] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const discovery = useRef(0), discoverModels = useRef(onDiscover); discoverModels.current = onDiscover;
  const mounted = useRef(true);
  const loaders = useRef(onPresets); loaders.current = onPresets;
  useEffect(() => {
    mounted.current = true;
    loaders.current?.().then(r => { if (mounted.current) setPresets(r.presets); }).catch(e => { if (mounted.current) setNote(e.message); });
    return () => { mounted.current = false; };
  }, []);
  const preset = presets.find(p => p.id === selected);
  useEffect(() => {
    if (!preset || busy || !discoverModels.current || (!preset.available && preset.auth.kind !== 'none')) return;
    const request = ++discovery.current;
    let cancelled = false;
    setLoadingModels(true); setNote('');
    // Browsing a connected provider is read-only. Saving keys and endpoint edits remains explicit.
    Promise.resolve().then(() => discoverModels.current(selected, { ...(form.model ? { model: form.model } : {}) }))
      .then(r => {
        if (cancelled || !mounted.current || discovery.current !== request) return;
        setReport(r); setNote(r.note ?? (r.models.length ? `${r.models.length} models available.` : 'No models reported. Try refreshing the model list.'));
      })
      .catch(error => { if (!cancelled && mounted.current && discovery.current === request) setNote(error.message); })
      .finally(() => { if (!cancelled && mounted.current && discovery.current === request) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [selected, preset?.available, preset?.auth.kind]);
  const found = report?.models.find(m => m.id === form.model);
  const decisionMode = preset?.protocol === 'typesafe' || found?.outputModalities?.includes("decisions");
  const issue = decisionMode ? null : modelChatIssue(found);
  const change = field => event => setForm(value => ({ ...value, [field]: event.target.value }));
  const choose = id => {
    if (id === selected) return;
    discovery.current++; setLoadingModels(false);
    const ref = current?.preset === id ? current : null;
    setSelected(id); setKey(''); setNote(''); setReport(null);
    setBaseUrl(settings?.providers?.[id]?.baseUrl ?? '');
    setForm({ model: ref?.model ?? '', reasoningEffort: ref?.effort ?? '', contextWindowTokens: ref?.contextWindowTokens ?? '', maxOutputTokens: ref?.maxOutputTokens ?? '' });
  };
  const perform = async action => {
    if (busy) return;
    discovery.current++; setLoadingModels(false);
    setBusy(true); setNote('');
    try { await action(); }
    catch (e) { if (mounted.current) setNote(key ? String(e.message).split(key).join('[redacted]') : e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const connection = async () => {
    const providers = ProviderOverridesSchema.parse({ [selected]: { baseUrl: baseUrl.trim() || null } });
    let stored;
    if (key) { stored = await onSetCredential(selected, key); setKey(''); }
    await onSaveConnection(providers);
    if (onPresets) { const r = await onPresets(); if (mounted.current) setPresets(r.presets); }
    return stored === 'session' ? ' API key lasts until the engine exits.' : '';
  };
  const discover = () => perform(async () => {
    const detail = await connection();
    const r = await onDiscover(selected, { refresh: true, ...(form.model ? { model: form.model } : {}) });
    if (mounted.current) { setReport(r); setNote((r.note ?? `${r.models.length} models available.`) + detail); }
  });
  const save = task => perform(async () => {
    let model = modelFromFields({ name: selected, ...form });
    const detail = await connection();
    if (onDiscover) {
      const r = await onDiscover(selected, { model: model.model });
      if (mounted.current) setReport(r);
      const selectedEntry = r.models.find(m => m.id === model.model);
      if (preset?.protocol === 'typesafe' || selectedEntry?.outputModalities?.includes("decisions")) { model.mode = decisionModeFor(preset, current); model.effort = null; }
      const problem = model.mode ? null : modelChatIssue(selectedEntry);
      if (problem) throw new Error(problem);
    }
    if (decisionMode) { model.mode = decisionModeFor(preset, current); model.effort = null; }
    model = pairDecisionModel(model, current, settings?.model);
    if (task) await onUseModel(model); else await onSaveDefault(model);
    if (mounted.current) setNote((task ? 'Model selected for the next run in this task.' : 'Model saved for this chat.') + detail);
  });

  return <div className="settings-provider">
    <div className="settings-provider-tabs" role="tablist" aria-label="Model providers">
      {presets.map(p => <button type="button" role="tab" aria-selected={selected === p.id} key={p.id} disabled={busy} onClick={() => choose(p.id)}>{p.displayName}</button>)}
    </div>
    <fieldset className="settings-fields" disabled={busy || !preset}>
      <section className="settings-card" aria-label={preset?.displayName ?? 'Model provider'}>
        <div className="settings-card-heading"><div><h2>{preset?.displayName ?? 'Loading providers…'}</h2><p className="hint">{preset?.auth.kind === 'none' ? 'No API key required.' : preset?.available ? `API key available (${preset.credentialSource}).` : 'An API key is required.'}</p></div></div>
        {preset?.auth.kind !== 'none' && <label>API key<input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" placeholder="Keep existing key" /></label>}
        {preset?.protocol !== 'fake' && <>
          <label>Base URL<input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={preset?.baseUrl} spellCheck={false} /></label>
          <div><button type="button" onClick={discover} disabled={!onDiscover}>{report ? 'Refresh models' : 'Find models'}</button></div>
          <label>Model<Select aria-label="Model for Jolo" value={form.model} disabled={loadingModels || (!form.model && !report?.models.length)} onChange={event => setForm(v => ({ ...v, model: event.target.value, reasoningEffort: '' }))}>
            {!form.model && <option value="">{loadingModels ? 'Loading models…' : report?.models.length ? 'Choose model' : 'No models loaded'}</option>}
            {form.model && !report?.models.some(m => m.id === form.model) && <option value={form.model}>{modelLabel(form.model)}</option>}
            {(report?.models ?? []).map(m => <option key={m.id} value={m.id} disabled={!m.outputModalities?.includes("decisions") && Boolean(modelChatIssue(m))}>{modelLabel(m.displayName || m.id)}{m.outputModalities?.includes('decisions') ? ' — typed decisions' : modelChatIssue(m) ? ' — unavailable for chat' : ''}</option>)}
          </Select></label>
          {found && <p className="hint">Context: {found.contextWindowTokens?.toLocaleString() ?? 'not reported'} · Maximum output: {found.maxOutputTokens?.toLocaleString() ?? 'not reported'}{found.supportsTools === false ? ' · Does not support tools' : ''}</p>}
          {issue && <p className="hint" role="alert">{issue}</p>}
          {decisionMode && <p className="hint">{preset?.protocol === 'typesafe' ? `${preset.displayName} connects directly to its decision API. Use it for browser control or typed decisions. Generated chat replies require a companion text model.` : 'This model handles structured decisions alongside your chat model. You can send normal messages or use the JSON example.'}</p>}
          <label>Reasoning effort<Select value={form.reasoningEffort} onChange={change('reasoningEffort')}><option value="">Provider default</option>{(found?.efforts?.length ? ['none', ...found.efforts.filter(e => e !== 'none')] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).map(e => <option key={e} value={e}>{e}</option>)}</Select></label>
          <details className="settings-advanced"><summary>Token limit overrides</summary><div className="settings-field-grid">
            <label>Context window<input type="number" min="1000" value={form.contextWindowTokens} onChange={change('contextWindowTokens')} placeholder="Automatic" /></label>
            <label>Max output<input type="number" min="16" value={form.maxOutputTokens} onChange={change('maxOutputTokens')} placeholder="Automatic" /></label>
          </div><p className="hint">Blank values use discovered limits or conservative provider defaults.</p></details>
        </>}
        {preset?.protocol === 'fake' && <p className="hint">A deterministic provider for local development.</p>}
        <div className="settings-model-actions"><button type="button" className="primary" disabled={loadingModels || Boolean(issue) || (!form.model && preset?.protocol !== 'fake')} onClick={() => save(false)}>Save for this chat</button>{session && onUseModel && <button type="button" disabled={loadingModels || Boolean(issue) || (!form.model && preset?.protocol !== 'fake')} onClick={() => save(true)}>Use for this task</button>}</div>

      </section>
    </fieldset>
    <p role="status" className="hint">{busy ? 'Working…' : loadingModels ? 'Loading models…' : note}</p>
  </div>;
}
import { pairDecisionModel, decisionModeFor } from '../decision-model.js';
