import { ProviderModels } from './provider-models.jsx';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
import { Select } from './select.jsx';
import { AgentLogo } from './brand.jsx';
import { FONT_DEFAULTS, readFonts, saveFonts, stackFor } from '../fonts.js';
import { DESKTOP_THEMES, readTheme, saveTheme } from '../themes.js';
import { modelLabel, effortLabel } from '../model-options.js';
import { AccountSettings } from './account-settings.jsx';
import { AboutSettings } from './about-settings.jsx';


const sections = [
  { id: 'account', label: 'Account', icon: 'shield' },
  { id: 'agents', label: 'Coding agents', icon: 'agents' },
  { id: 'provider', label: 'Models', icon: 'settings', description: 'Model choices apply to future runs.' },
  { id: 'appearance', label: 'Appearance', icon: 'board' },
  { id: 'about', label: 'About', icon: 'circleCheck' },
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function AgentModels({ agents, form, onChange, onSave, onDiscover, hidden = new Set(), onHide = null }) {
  const [found, setFound] = useState({});
  const [asking, setAsking] = useState({});
  const [saving, setSaving] = useState({}), [failed, setFailed] = useState({});
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
  const choose = async (agentId, entry) => {
    const previous = form[agentId] ?? { model: '', effort: '' };
    onChange(agentId, entry);
    setFailed(current => ({ ...current, [agentId]: null })); setSaving(current => ({ ...current, [agentId]: true }));
    try { await onSave?.({ [agentId]: { model: entry.model.trim() || null, effort: entry.effort.trim() || null } }); }
    catch (error) { onChange(agentId, previous); setFailed(current => ({ ...current, [agentId]: error.message })); }
    finally { setSaving(current => ({ ...current, [agentId]: false })); }
  };
  return <div className="settings-agent-list">
    <div className="agent-list-summary"><span>Agent preferences</span><span>{configurable.filter(agent => agent.available).length} installed</span></div>
    {!configurable.length && <p className="hint">No configurable agents are available yet.</p>}
    {configurable.map(agent => {
      const entry = form[agent.id] ?? { model: '', effort: '' };
      const report = found[agent.id];
      const isHidden = hidden.has(`agent:${agent.id}`);
      return <section key={agent.id} className={`agent-model-row${isHidden ? ' hidden' : ''}`} aria-label={agent.displayName}>
        <div className="agent-identity">
          <span className="agent-avatar" aria-hidden="true"><AgentLogo agentId={agent.id} /></span>
          <div><h2>{agent.displayName}</h2><span className={`agent-install-state ${agent.available ? 'installed' : ''}`}><i />{agent.available ? 'Installed' : 'Not installed'}</span></div>
          <button type="button" className="agent-refresh" aria-label={`Refresh models for ${agent.displayName}`} disabled={!agent.available || asking[agent.id]} onClick={() => discover(agent.id, true)} title={`Refresh models for ${agent.displayName}`}><Icon name="refresh" size={14} /></button>
          {onHide && <button type="button" className="source-hide" aria-pressed={isHidden} title={isHidden ? `Show ${agent.displayName} in the model menu` : `Hide ${agent.displayName} from the model menu`} onClick={() => onHide(`agent:${agent.id}`, !isHidden)}>{isHidden ? 'Hidden' : 'Hide'}</button>}
        </div>
        <div className="settings-field-grid agent-preferences">
          {agent.supportsModel && <label>Model<Select aria-label={`Model for ${agent.displayName}`} value={entry.model} disabled={saving[agent.id]} onChange={event => choose(agent.id, { ...entry, model: event.target.value })}>
            <option value="">Default</option>
            {entry.model && !report?.models?.some(model => model.id === entry.model) && <option value={entry.model}>{modelLabel(entry.model)}</option>}
            {(report?.models ?? []).map(model => <option key={model.id} value={model.id}>{modelLabel(model.displayName || model.id)}</option>)}
          </Select></label>}
          {agent.supportsEffort && <label>Reasoning effort<Select aria-label={`Effort for ${agent.displayName}`} value={entry.effort} disabled={saving[agent.id]} onChange={event => choose(agent.id, { ...entry, effort: event.target.value })}>
            <option value="">Default</option>
            {entry.effort && !report?.efforts?.includes(entry.effort) && <option value={entry.effort}>{effortLabel(entry.effort)}</option>}
            {(report?.efforts ?? []).map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
          </Select></label>}
        </div>
        {failed[agent.id] ? <p className="agent-model-note settings-save-error" role="alert">{failed[agent.id]}</p> : (asking[agent.id] || report) && <p className="hint agent-model-note" role="status">{asking[agent.id] ? 'Loading models and reasoning efforts…' : report.note ?? `${report.models.length} model${report.models.length === 1 ? '' : 's'} available`}</p>}
      </section>;
    })}
    <p className="hint agent-default-hint">Choose a model and effort level. Default follows each agent’s own settings.</p>
  </div>;
}

export function SettingsPage({ settings, agents = [], onSave, onSaveAgents, onDiscoverModels, onSetCredential, onClose, initialSection = 'agents', session, onPresets, onDiscoverProviderModels, onSaveConnection, onUseModel, onGetStarted = null, onHideSource = null }) {
  const [section, setSection] = useState(initialSection);
  const [agentForm, setAgentForm] = useState(() => Object.fromEntries(agents.map(agent => [agent.id, { model: agent.model ?? '', effort: agent.effort ?? '' }])));
  const [fonts, setFonts] = useState(readFonts), [draft, setDraft] = useState(fonts);
  const [theme, setTheme] = useState(readTheme);
  const id = useId(), heading = useRef(null), scroll = useRef(null), close = useRef(onClose), pending = useRef({ draft, fonts });
  close.current = onClose; pending.current = { draft, fonts };
  const current = sections.find(item => item.id === section);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [section]);
  useEffect(() => () => { if (!same(pending.current.draft, pending.current.fonts)) saveFonts(pending.current.draft); }, []);
  useEffect(() => {
    // Catalog discovery can finish after Settings opens; populate new entries without replacing edits.
    const missing = Object.fromEntries(agents.filter(agent => !Object.hasOwn(agentForm, agent.id)).map(agent => [agent.id, { model: agent.model ?? '', effort: agent.effort ?? '' }]));
    if (!Object.keys(missing).length) return;
    setAgentForm(current => ({ ...current, ...missing }));
  }, [agents, agentForm]);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) close.current(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  const storeFonts = next => { const clean = saveFonts(next); setFonts(clean); setDraft(clean); };
  const commitFonts = () => { if (!same(draft, fonts)) storeFonts(draft); };

  return <section className="settings-page" aria-label="Settings">
    <nav className="settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = /** @type {HTMLElement[]} */ ([...event.currentTarget.querySelectorAll('[role=tab]')]), index = tabs.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    }}>
      {sections.map(item => <button key={item.id} type="button" data-section={item.id} role="tab" id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)}><Icon name={item.icon} size={15} />{item.label}</button>)}
    </nav>
    <div className="settings-form">
      <div className="settings-scroll" ref={scroll}>
        <div className="settings-content">
          <header className="settings-heading"><h1 ref={heading} tabIndex={-1}>{current.label}</h1>{current.description && <p>{current.description}</p>}</header>
          <fieldset className="settings-fields">
            <div role="tabpanel" id={`${id}-account`} aria-labelledby={`${id}-account-tab`} hidden={section !== 'account'}>{section === 'account' && <AccountSettings />}</div>
            <div role="tabpanel" id={`${id}-agents`} aria-labelledby={`${id}-agents-tab`} hidden={section !== 'agents'}><AgentModels agents={agents} form={agentForm} hidden={new Set(settings?.hiddenSources ?? [])} onHide={onHideSource} onChange={(agentId, entry) => setAgentForm(current => ({ ...current, [agentId]: entry }))} onSave={onSaveAgents} onDiscover={onDiscoverModels} /></div>
            <div role="tabpanel" id={`${id}-provider`} aria-labelledby={`${id}-provider-tab`} hidden={section !== 'provider'}>
              <ProviderModels settings={settings} session={session} onHide={onHideSource} onPresets={onPresets} onDiscover={onDiscoverProviderModels} onSaveConnection={onSaveConnection} onSaveDefault={onSave} onUseModel={onUseModel} onSetCredential={onSetCredential} />
            </div>
            <div className="settings-appearance" role="tabpanel" id={`${id}-appearance`} aria-labelledby={`${id}-appearance-tab`} hidden={section !== 'appearance'}>
              <section className="settings-card">
                <div className="settings-card-heading"><div><h2>Theme</h2><p className="hint">The same color themes as the CLI. System default follows your computer’s appearance.</p></div></div>
                <label>Color theme<Select aria-label="Color theme" value={theme} onChange={event => setTheme(saveTheme(event.target.value))}>
                  {DESKTOP_THEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select></label>
                <p className="hint">Applies to the interface, code, diffs and terminals on this device.</p>
              </section>
              <section className="settings-card">
                <div className="settings-card-heading"><div><h2>Fonts</h2><p className="hint">Use a bundled font or any font installed on your computer.</p></div></div>
                {[['sans', 'Interface'], ['mono', 'Code and diffs'], ['terminal', 'Terminal']].map(([kind, label]) => <label key={kind}>{label}<input value={draft[kind]} onChange={event => setDraft({ ...draft, [kind]: event.target.value })} onBlur={commitFonts} onKeyDown={event => { if (event.key === 'Enter') commitFonts(); }} placeholder={FONT_DEFAULTS[kind]} spellCheck={false} style={{ fontFamily: stackFor(kind, draft) }} /></label>)}
                <button type="button" className="settings-reset" onClick={() => storeFonts({ ...FONT_DEFAULTS })}>Reset to bundled fonts</button>
              </section>
            </div>
            <div className="settings-about" role="tabpanel" id={`${id}-about`} aria-labelledby={`${id}-about-tab`} hidden={section !== 'about'}>{section === 'about' && <>
              <AboutSettings />
              {onGetStarted && <section className="settings-card"><div className="settings-card-heading"><div><h2>Getting started</h2><p className="hint">Walk through choosing an agent and starting a first task again.</p></div><button type="button" className="outline" onClick={onGetStarted}>Open guide</button></div></section>}
            </>}</div>
          </fieldset>
        </div>
      </div>
    </div>
  </section>;
}
