import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
import { ModelLogo } from './brand.jsx';
import { effortLabel, modelEfforts, effortForModel, fastForModel, modelLabel, modelSupportsFast } from '../model-options.js';

/** Quick access to the same saved model preferences used by Settings. */
export function ModelControls({ agentId, agents, nativeModel, hasSession, disabled, onSave, call, onSettings, onOpenChange, hiddenSources = [] }) {
  const trigger = useRef(null), effortTrigger = useRef(null), opener = useRef(null), search = useRef(null), panel = useRef(null), busy = useRef(false), alive = useRef(true);
  const id = useId();
  const [open, setOpen] = useState(false), [view, setView] = useState('models');
  const [reports, setReports] = useState({}), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [presets, setPresets] = useState([]);
  const [browsing, setBrowsing] = useState({ agentId, preset: nativeModel?.preset ?? '' });
  const [query, setQuery] = useState('');
  const browsingModels = view === 'models';
  const activeAgentId = browsingModels ? browsing.agentId : agentId;
  const preset = browsingModels ? browsing.preset : nativeModel?.preset ?? '';
  const [refresh, setRefresh] = useState(0);
  const agent = agents.find(entry => entry.id === activeAgentId);
  const agentName = agent?.displayName ?? 'Jolo';
  const source = activeAgentId === 'jolo' ? `provider:${preset}` : `agent:${activeAgentId}`;
  const selectedModel = agent ? agent.model : nativeModel?.preset === preset ? nativeModel?.model : null;
  const effort = agent ? agent.effort : nativeModel?.preset === preset ? nativeModel?.effort : null;
  // Fast mode is an installed agent's own option; Jolo's providers do not offer it yet.
  const fast = Boolean(agent?.fast);
  const report = reports[source];
  const chosen = report?.models.find(entry => selectedModel ? entry.id === selectedModel : entry.isDefault);
  const label = chosen?.displayName ?? selectedModel ?? `${agentName} default`;
  const levels = modelEfforts(report, selectedModel, agent ? agent.supportsEffort : true);
  // Offered where the model has it, and kept in view while on, so a model chosen elsewhere never hides the way out.
  const fastOffered = Boolean(agent?.supportsFast) && (fast || modelSupportsFast(report, selectedModel));
  const steps = [null, ...levels];
  const latest = useRef({ onOpenChange, call }); latest.current = { onOpenChange, call };

  useEffect(() => {
    alive.current = true;
    const element = panel.current;
    const changed = () => {
      const shown = element.matches(':popover-open');
      setOpen(shown); latest.current.onOpenChange(shown);
      if (shown) setError('');
    };
    const close = () => element.hidePopover();
    element.addEventListener('toggle', changed); window.addEventListener('resize', close);
    return () => { alive.current = false; element.removeEventListener('toggle', changed); window.removeEventListener('resize', close); latest.current.onOpenChange(false); };
  }, []);
  useEffect(() => {
    // The effort list opens on its current row, so arrow keys and Enter work at once.
    if (open) (panel.current.querySelector('input[type=search]') ?? panel.current.querySelector('.effort-list [aria-selected="true"]') ?? panel.current.querySelector('button'))?.focus({ preventScroll: true });
  }, [open, view]);
  useEffect(() => { if (disabled) panel.current.hidePopover(); }, [disabled]);
  useEffect(() => { setError(''); }, [source, selectedModel, effort]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    latest.current.call('provider.presets', {}).then(result => { if (!cancelled) setPresets(result.presets); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    if (!open || (activeAgentId === 'jolo' && !preset)) { setLoading(false); return; }
    if (reports[source] && !refresh) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError('');
    latest.current.call(agent ? 'agent.models' : 'provider.models', agent ? { agentId: activeAgentId, refresh: Boolean(refresh) } : { preset, refresh: Boolean(refresh) })
      .then(result => { if (!cancelled) setReports(current => ({ ...current, [source]: result })); })
      .catch(error => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, source, refresh]);
  const dismiss = () => { panel.current.hidePopover(); opener.current?.focus(); };
  const save = async (model, nextEffort, nextFast, nextView = view) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    // Fast is named only when it changes, so an engine from before fast mode still takes every other choice.
    try { await onSave({ agentId: activeAgentId, preset, model: model || null, effort: nextEffort || null, fast: nextFast === fast ? undefined : nextFast }); if (alive.current) { if (browsingModels) dismiss(); else setView(nextView); } }
    catch (error) { if (alive.current) setError(error.message); }
    finally { busy.current = false; if (alive.current) setSaving(false); }
  };
  // The menu lists what is set up and not hidden in Settings; the source in use, or being browsed, always stays reachable.
  const inUse = agents.some(entry => entry.id === agentId) ? `agent:${agentId}` : `provider:${nativeModel?.preset}`;
  const sources = [
    ...agents.map(entry => ({ key: `agent:${entry.id}`, agentId: entry.id, preset: '', name: entry.displayName, available: entry.available })),
    ...presets.map(entry => ({ key: `provider:${entry.id}`, agentId: 'jolo', preset: entry.id, name: entry.displayName, available: entry.available })),
  ].filter(entry => (entry.available && !hiddenSources.includes(entry.key)) || entry.key === source || entry.key === inUse);
  const term = query.trim().toLowerCase();
  const sourceName = sources.find(entry => entry.key === source)?.name ?? agentName;
  const choices = (report?.models ?? []).filter(model => `${modelLabel(model.displayName || model.id)} ${model.id} ${sourceName}`.toLowerCase().includes(term));
  const canModel = !agent || agent.supportsModel;
  const currentAgent = agents.find(entry => entry.id === agentId);
  const currentModel = currentAgent ? currentAgent.model : nativeModel?.model;
  const currentEffort = currentAgent ? currentAgent.effort : nativeModel?.effort;
  const currentReport = reports[currentAgent ? `agent:${agentId}` : `provider:${nativeModel?.preset}`];
  const currentFast = Boolean(currentAgent?.fast) && (!currentReport || modelSupportsFast(currentReport, currentModel));
  const currentLabel = currentReport?.models.find(model => currentModel ? model.id === currentModel : model.isDefault)?.displayName ?? currentModel ?? currentAgent?.displayName ?? 'Choose model';
  const show = (nextView, button) => {
    if (open && view === nextView) { dismiss(); return; }
    opener.current = button;
    setView(nextView); setBrowsing({ agentId, preset: nativeModel?.preset ?? '' }); setQuery(''); setError(''); setRefresh(0);
    const rect = button.getBoundingClientRect(), element = panel.current;
    const width = nextView === 'models' ? 544 : 264;
    element.style.left = `${Math.max(8, Math.min(rect.left - 8, innerWidth - width - 8))}px`;
    element.style.bottom = `${Math.max(8, innerHeight - rect.top + 10)}px`;
    element.style.maxHeight = `${Math.max(110, rect.top - 18)}px`;
    element.style.setProperty('--menu-height', `${Math.max(110, rect.top - 18)}px`);
    // Native popover autofocus can reach a provider before the new view commits.
    // Browse on focus only once the open state is committed; then focus search.
    element.showPopover();
  };
  const browse = entry => {
    if (saving || source === entry.key) return;
    setBrowsing({ agentId: entry.agentId, preset: entry.preset }); setError(''); setRefresh(0);
  };
  const focusSource = () => panel.current.querySelector('.model-provider-list button[aria-pressed=true]')?.focus();
  return <>
    <button ref={trigger} type="button" className="model-select" aria-label="Choose model" aria-haspopup="dialog" aria-expanded={open && browsingModels} aria-controls={id} popoverTarget={id} disabled={disabled} title={modelLabel(currentLabel)} onClick={event => { event.preventDefault(); show('models', event.currentTarget); }}><ModelLogo model={currentModel} agentId={agentId} preset={nativeModel?.preset} /><span>{modelLabel(currentLabel)}</span><Icon name="down" size={12} /></button>
    <button ref={effortTrigger} type="button" className="model-effort-select" aria-label="Choose reasoning effort" aria-haspopup="dialog" aria-expanded={open && !browsingModels} aria-controls={id} popoverTarget={id} disabled={disabled} title={currentFast ? 'Fast mode is on' : undefined} onClick={event => { event.preventDefault(); show('effort', event.currentTarget); }}>{currentFast && <Icon name="fast" size={12} />}{effortLabel(currentEffort)}<Icon name="down" size={12} /></button>
    <div ref={panel} id={id} className={`model-popover${browsingModels ? ' model-browser' : ''}`} popover="auto" role="dialog" aria-label="Model and reasoning effort" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      // Enter in a popover must never submit the surrounding message composer.
      if (event.key === 'Enter') { event.stopPropagation(); if (event.target instanceof HTMLInputElement) event.preventDefault(); }
      if (event.key === 'Tab') {
        const items = [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
        if ((event.shiftKey && document.activeElement === items[0]) || (!event.shiftKey && document.activeElement === items.at(-1))) dismiss();
      }
    }}>
      {view === 'effort' ? <div className="effort-list" role="listbox" aria-label="Reasoning effort" onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const options = /** @type {HTMLButtonElement[]} */ ([...event.currentTarget.querySelectorAll('button:not(:disabled)')]);
        const at = options.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
      }}>
        {levels.length > 0 ? steps.map(step => <button type="button" role="option" key={step ?? 'default'} data-effort={step ?? ''} aria-selected={(effort ?? null) === step} disabled={saving || loading} onClick={() => { if (step !== (effort ?? null)) void save(selectedModel, step, fast); dismiss(); }}><span>{effortLabel(step)}</span>{(effort ?? null) === step && <Icon name="check" size={14} className="effort-check" />}</button>)
          : <p className="model-status" role="status">{loading ? 'Loading effort levels…' : !report && !agent ? 'Choose a connected model to get started.' : report?.note ?? 'Effort levels aren’t reported for this model.'}</p>}
        {fastOffered && <><div className="effort-divider" aria-hidden="true" /><button type="button" role="option" className="effort-fast" data-effort="fast" aria-selected={fast} disabled={saving} title="Faster replies that use more of your plan" onClick={() => void save(selectedModel, effort, !fast)}><Icon name="fast" size={14} /><span>Fast</span>{fast && <Icon name="check" size={14} className="effort-check" />}</button></>}
      </div> : <div className="model-cascade">
        <div className="model-providers">
          <div className="model-provider-list" role="group" aria-label="Agents and providers" onKeyDown={event => {
            if (event.key === 'ArrowRight') { event.preventDefault(); search.current?.focus(); }
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = /** @type {HTMLButtonElement[]} */ ([...event.currentTarget.querySelectorAll('button:not(:disabled)')]);
              const index = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
              buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}>
            {sources.map(entry => <button type="button" key={entry.key} data-source={entry.key} aria-pressed={source === entry.key} aria-controls={`${id}-models`} disabled={saving} title={!entry.available ? entry.agentId === 'jolo' ? 'Connect in Settings' : 'Not installed' : entry.name} onPointerMove={event => { if (event.pointerType === 'mouse' && (event.movementX || event.movementY)) browse(entry); }} onFocus={() => { if (open) browse(entry); }} onClick={() => { browse(entry); search.current?.focus(); }}>
              <ModelLogo model={null} agentId={entry.agentId} preset={entry.preset} /><span>{entry.name}</span><Icon name="chevron" size={14} />
            </button>)}
          </div>
          <button type="button" className="model-add-provider" onClick={() => { dismiss(); onSettings('provider'); }}><Icon name="plus" size={16} />Add Providers</button>
        </div>
        <div className="model-submenu" id={`${id}-models`} aria-label={`${sourceName} models`}>
          <div className="model-search"><input ref={search} type="search" aria-label="Search models or providers" placeholder="Search models or providers" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); panel.current.querySelector('.model-choices button:not(:disabled)')?.focus(); }
            if (event.key === 'ArrowLeft' && !query) { event.preventDefault(); focusSource(); }
          }} /><button type="button" aria-label="Refresh models" title="Refresh models" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={14} /></button></div>
          <div className="model-choices" role="group" aria-label="Available models" onKeyDown={event => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); focusSource(); }
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = /** @type {HTMLButtonElement[]} */ ([...event.currentTarget.querySelectorAll('button:not(:disabled)')]);
              const index = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
              if (event.key === 'ArrowUp' && index === 0) search.current?.focus();
              else buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}>
            {term && sources.filter(entry => entry.key !== source && entry.name.toLowerCase().includes(term)).map(entry => <button type="button" key={entry.key} disabled={saving} onClick={() => { browse(entry); setQuery(''); search.current?.focus(); }}><span><strong>{entry.name}</strong><small>Browse models</small></span><Icon name="chevron" size={14} /></button>)}
            {agent && canModel && !term && <button type="button" aria-pressed={!selectedModel} disabled={saving || !agent.available} onClick={() => save(null, null, fastForModel(report, null, fast))}><span><strong>Default</strong><small>{agentName} chooses the model</small></span>{!selectedModel && <Icon name="check" size={15} />}</button>}
            {choices.map(model => <button type="button" key={model.id} data-model={model.id} aria-pressed={selectedModel === model.id} disabled={saving || !canModel || !sources.find(entry => entry.key === source)?.available} onClick={() => save(model.id, effortForModel(report, model.id, effort), fastForModel(report, model.id, fast))}><span><strong>{modelLabel(model.displayName || model.id)}</strong></span>{selectedModel === model.id && <Icon name="check" size={15} />}</button>)}
            {loading && <p className="model-status" role="status">Loading models…</p>}
            {!loading && !choices.length && <p className="model-status" role="status">{term ? 'No matching models for this provider.' : report?.note ?? 'Choose a provider or connect one in Settings.'}</p>}
            {error && <p className="model-error" role="alert">{error}</p>}
          </div>
        </div>
      </div>}
      {error && !browsingModels && <p className="model-error" role="alert">{error}</p>}
    </div>
  </>;
}
