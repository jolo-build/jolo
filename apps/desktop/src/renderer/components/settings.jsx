import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
import { Select } from './select.jsx';
import { Combobox } from './combobox.jsx';
import { FONT_DEFAULTS, readFonts, saveFonts } from '../fonts.js';
import { AccountSettings } from './account-settings.jsx';

const sections = [
  { id: 'account', label: 'Account', icon: 'shield', description: 'Connect your Jolo account and manage this device.' },
  { id: 'agents', label: 'Coding agents', icon: 'agents', description: 'Choose how each installed agent answers your tasks.' },
  { id: 'provider', label: 'Model provider', icon: 'settings', description: 'Connect the model Jolo uses to answer your prompts.' },
  { id: 'appearance', label: 'Appearance', icon: 'board', description: 'Make your workspace comfortable to read.' },
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function AgentModels({ agents, form, onChange, onDiscover, disabled }) {
  const [found, setFound] = useState({});
  const [asking, setAsking] = useState({});
  const requested = useRef(new Set());
  const inFlight = useRef(new Set());
  const discoverModels = useRef(onDiscover);
  discoverModels.current = onDiscover;
  const configurable = agents.filter(agent => agent.supportsModel || agent.supportsEffort);
  const discover = useCallback(async (agentId, refresh = false) => {
    if (inFlight.current.has(agentId) || !discoverModels.current) return;
    inFlight.current.add(agentId);
    setAsking(current => ({ ...current, [agentId]: true }));
    try { const report = await discoverModels.current(agentId, { refresh }); setFound(current => ({ ...current, [agentId]: report })); }
    catch (error) { setFound(current => ({ ...current, [agentId]: { models: [], efforts: [], note: error.message } })); }
    finally { inFlight.current.delete(agentId); setAsking(current => ({ ...current, [agentId]: false })); }
  }, []);
  useEffect(() => {
    if (!onDiscover) return;
    for (const agent of agents) {
      if (!agent.available || !(agent.supportsModel || agent.supportsEffort) || requested.current.has(agent.id)) continue;
      requested.current.add(agent.id);
      void discover(agent.id);
    }
  }, [agents, onDiscover, discover]);
  return <div className="settings-agent-list">
    {!configurable.length && <p className="hint">No configurable agents are available yet.</p>}
    {configurable.map(agent => {
      const entry = form[agent.id] ?? { model: '', effort: '' };
      const report = found[agent.id];
      return <section key={agent.id} className="settings-card agent-model-row" aria-label={agent.displayName}>
        <div className="settings-card-heading">
          <div><h2>{agent.displayName}</h2><span className="hint">{agent.available ? 'Installed' : 'Not installed'}</span></div>
          <button type="button" className="outline" disabled={disabled || !agent.available || asking[agent.id]} onClick={() => discover(agent.id, true)} title={`Refresh available models and reasoning efforts from ${agent.displayName}`}><Icon name="refresh" size={13} />{asking[agent.id] ? 'Loading…' : 'Refresh models'}</button>
        </div>
        <div className="settings-field-grid">
          {agent.supportsModel && <label>Model<Combobox label={`Model for ${agent.displayName}`} value={entry.model} disabled={disabled} onChange={model => onChange(agent.id, { ...entry, model })}
            options={(report?.models ?? []).map(model => ({ value: model.id, label: model.displayName || model.id, description: model.displayName && model.displayName !== model.id ? model.id : undefined }))} /></label>}
          {agent.supportsEffort && <label>Reasoning effort<Combobox label={`Effort for ${agent.displayName}`} value={entry.effort} disabled={disabled} onChange={effort => onChange(agent.id, { ...entry, effort })}
            options={(report?.efforts ?? []).map(effort => ({ value: effort, label: effort }))} /></label>}
        </div>
        {(asking[agent.id] || report) && <p className="hint agent-model-note" role="status">{asking[agent.id] ? 'Loading models and reasoning efforts…' : report.note ?? `${report.models.length} model${report.models.length === 1 ? '' : 's'} available from ${agent.displayName}.`}</p>}
      </section>;
    })}
    <p className="hint">Choose Default to use the agent’s own settings. You can also enter a custom model or effort.</p>
  </div>;
}

export function SettingsPage({ settings, agents = [], onSave, onSaveAgents, onDiscoverModels, onSetCredential, onClose }) {
  const provider = settings?.provider;
  const [section, setSection] = useState('agents');
  const [form, setForm] = useState(() => ({ name: provider?.name ?? 'fake', model: provider?.model ?? '', contextWindowTokens: provider?.contextWindowTokens ?? 200000, maxOutputTokens: provider?.maxOutputTokens ?? 8000, baseUrl: provider?.baseUrl ?? '', reasoningEffort: provider?.reasoningEffort ?? '' }));
  const [agentForm, setAgentForm] = useState(() => Object.fromEntries(agents.map(agent => [agent.id, { model: agent.model ?? '', effort: agent.effort ?? '' }])));
  const [fonts, setFonts] = useState(readFonts);
  const [saved, setSaved] = useState(() => ({ form, agents: agentForm, fonts }));
  const [key, setKey] = useState(''), [note, setNote] = useState(null), [busy, setBusy] = useState(false);
  const id = useId(), heading = useRef(null), scroll = useRef(null), close = useRef(onClose);
  close.current = onClose;
  const dirty = !same(form, saved.form) || !same(agentForm, saved.agents) || !same(fonts, saved.fonts) || Boolean(key);
  const current = sections.find(item => item.id === section);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [section]);
  useEffect(() => {
    // Catalog discovery can finish after Settings opens; populate new entries without replacing edits.
    const missing = Object.fromEntries(agents.filter(agent => !Object.hasOwn(agentForm, agent.id)).map(agent => [agent.id, { model: agent.model ?? '', effort: agent.effort ?? '' }]));
    if (!Object.keys(missing).length) return;
    setAgentForm(current => ({ ...current, ...missing }));
    setSaved(current => ({ ...current, agents: { ...current.agents, ...missing } }));
  }, [agents, agentForm]);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented && !busy && !document.querySelector('dialog[open]')) close.current(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [busy]);
  const update = field => event => { setForm({ ...form, [field]: event.target.value }); setNote(null); if (field === 'name' && event.target.value === 'fake') setKey(''); };
  const discard = () => { setForm(saved.form); setAgentForm(saved.agents); setFonts(saved.fonts); setKey(''); setNote(null); };
  const save = async event => {
    event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true); setNote(null);
    try {
      if (!same(form, saved.form)) {
        const value = form.name === 'fake' ? null : { name: form.name, model: form.model.trim(), contextWindowTokens: Number(form.contextWindowTokens), maxOutputTokens: Number(form.maxOutputTokens), ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}), ...(form.reasoningEffort ? { reasoningEffort: form.reasoningEffort } : {}) };
        await onSave(value);
      }
      if (!same(agentForm, saved.agents) && onSaveAgents) await onSaveAgents(Object.fromEntries(Object.entries(agentForm).map(([agentId, entry]) => [agentId, { model: entry.model.trim() || null, effort: entry.effort.trim() || null }])));
      if (key && form.name === 'openai') await onSetCredential('openai', key);
      const nextFonts = !same(fonts, saved.fonts) ? saveFonts(fonts) : fonts;
      setFonts(nextFonts); setKey(''); setSaved({ form, agents: agentForm, fonts: nextFonts }); setNote({ text: 'Changes saved.' });
    } catch (error) { setNote({ text: error.message, error: true }); }
    finally { setBusy(false); }
  };

  return <section className="settings-page" aria-label="Settings">
    <nav className="settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll('[role=tab]')], index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    }}>
      <span className="settings-nav-label">Settings</span>
      {sections.map(item => <button key={item.id} type="button" data-section={item.id} role="tab" id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => { setSection(item.id); setNote(null); }}><Icon name={item.icon} size={15} />{item.label}</button>)}
    </nav>
    <form className="settings-form" onSubmit={save}>
      <div className="settings-scroll" ref={scroll}>
        <div className="settings-content">
          <header className="settings-heading"><h1 ref={heading} tabIndex={-1}>{current.label}</h1><p>{current.description}</p></header>
          <fieldset disabled={busy} className="settings-fields">
            <div role="tabpanel" id={`${id}-account`} aria-labelledby={`${id}-account-tab`} hidden={section !== 'account'}>{section === 'account' && <AccountSettings />}</div>
            <div role="tabpanel" id={`${id}-agents`} aria-labelledby={`${id}-agents-tab`} hidden={section !== 'agents'}><AgentModels agents={agents} form={agentForm} disabled={busy} onChange={(agentId, entry) => { setAgentForm({ ...agentForm, [agentId]: entry }); setNote(null); }} onDiscover={onDiscoverModels} /></div>
            <div role="tabpanel" id={`${id}-provider`} aria-labelledby={`${id}-provider-tab`} hidden={section !== 'provider'} className="settings-provider">
              <section className="settings-card">
                <label>Provider<Select value={form.name} onChange={update('name')}><option value="fake">Demo provider</option><option value="openai">OpenAI</option></Select></label>
                {form.name === 'fake' ? <p className="hint">Try Jolo locally without an API key.</p> : <>
                  <label>Model<input value={form.model} onChange={update('model')} placeholder="Model ID" autoComplete="off" spellCheck={false} /></label>
                  <label>API key<input type="password" value={key} onChange={event => { setKey(event.target.value); setNote(null); }} autoComplete="off" placeholder="Enter a key to add or replace it" /><span className="hint">Stored securely in your OS keychain.</span></label>
                </>}
              </section>
              {form.name !== 'fake' && <details className="settings-advanced"><summary><Icon name="chevron" size={13} />Advanced configuration</summary>
                <div className="settings-card">
                  <div className="settings-field-grid"><label>Context window (tokens)<input type="number" min="1" value={form.contextWindowTokens} onChange={update('contextWindowTokens')} /></label><label>Max output (tokens)<input type="number" min="1" value={form.maxOutputTokens} onChange={update('maxOutputTokens')} /></label></div>
                  <p className="hint">Set the limits supported by your model.</p>
                  <label>Base URL<input value={form.baseUrl} onChange={update('baseUrl')} placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} /></label>
                  <label>Reasoning effort<Select value={form.reasoningEffort} onChange={update('reasoningEffort')}><option value="">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select></label>
                </div>
              </details>}
            </div>
            <div role="tabpanel" id={`${id}-appearance`} aria-labelledby={`${id}-appearance-tab`} hidden={section !== 'appearance'}>
              <section className="settings-card">
                <div className="settings-card-heading"><div><h2>Fonts</h2><p className="hint">Use a bundled font or any font installed on your computer.</p></div></div>
                {[['sans', 'Interface'], ['mono', 'Code and diffs'], ['terminal', 'Terminal']].map(([kind, label]) => <label key={kind}>{label}<input value={fonts[kind]} onChange={event => { setFonts({ ...fonts, [kind]: event.target.value }); setNote(null); }} placeholder={FONT_DEFAULTS[kind]} spellCheck={false} /></label>)}
                <button type="button" className="settings-reset" onClick={() => { setFonts({ ...FONT_DEFAULTS }); setNote(null); }}>Reset to bundled fonts</button>
              </section>
              <div className="settings-font-preview"><span className="settings-nav-label">Preview</span><p style={{ fontFamily: `${JSON.stringify(fonts.sans)}, var(--sans)` }}>A little help. A lot of possibility.</p><code style={{ fontFamily: `${JSON.stringify(fonts.mono)}, var(--mono)` }}>const answer = 42;</code><span className="terminal-sample" style={{ fontFamily: `${JSON.stringify(fonts.terminal)}, var(--terminal-font)` }}>~/project $ bun run dev</span></div>
            </div>
          </fieldset>
        </div>
      </div>
      <footer className="settings-savebar"><span role={note?.error ? 'alert' : 'status'} className={note?.error ? 'settings-save-error' : 'hint'}>{note?.text || (dirty ? 'Unsaved changes' : 'All changes saved')}</span><div>{dirty && <button type="button" disabled={busy} onClick={discard}>Discard changes</button>}<button type="submit" className="primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save changes'}</button></div></footer>
    </form>
  </section>;
}
