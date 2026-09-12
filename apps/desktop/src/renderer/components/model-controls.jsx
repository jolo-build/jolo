import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
import { ModelLogo } from './brand.jsx';
import { Select } from './select.jsx';
import { effortLabel, modelEfforts, effortForModel, modelLabel } from '../model-options.js';

/** Quick access to the same saved model preferences used by Settings. */
export function ModelControls({ agentId, agents, nativeModel, hasSession, disabled, onAgent, onSave, call, onSettings, onOpenChange }) {
  const trigger = useRef(null), panel = useRef(null), busy = useRef(false), alive = useRef(true);
  const id = useId();
  const [open, setOpen] = useState(false), [view, setView] = useState('effort');
  const [reports, setReports] = useState({}), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState(nativeModel?.preset ?? '');
  const [preview, setPreview] = useState(undefined);
  const [refresh, setRefresh] = useState(0);
  const agent = agents.find(entry => entry.id === agentId);
  const agentName = agent?.displayName ?? 'Jolo';
  const source = agentId === 'jolo' ? `provider:${preset}` : `agent:${agentId}`;
  const selectedModel = agent ? agent.model : nativeModel?.preset === preset ? nativeModel?.model : null;
  const effort = agent ? agent.effort : nativeModel?.preset === preset ? nativeModel?.effort : null;
  const report = reports[source];
  const chosen = report?.models.find(entry => selectedModel ? entry.id === selectedModel : entry.isDefault);
  const label = chosen?.displayName ?? selectedModel ?? `${agentName} default`;
  const levels = modelEfforts(report, selectedModel, agent ? agent.supportsEffort : true);
  const steps = [null, ...levels];
  const shownEffort = preview === undefined ? effort : preview;
  const index = Math.max(0, steps.indexOf(shownEffort ?? null));
  const latest = useRef({ onOpenChange, call }); latest.current = { onOpenChange, call };

  useEffect(() => {
    alive.current = true;
    const element = panel.current;
    const changed = () => {
      const shown = element.matches(':popover-open');
      setOpen(shown); latest.current.onOpenChange(shown);
      if (shown) { setView('effort'); setError(''); (element.querySelector('input[type=range]') ?? element.querySelector('button'))?.focus({ preventScroll: true }); }
    };
    const close = () => element.hidePopover();
    element.addEventListener('toggle', changed); window.addEventListener('resize', close);
    return () => { alive.current = false; element.removeEventListener('toggle', changed); window.removeEventListener('resize', close); latest.current.onOpenChange(false); };
  }, []);
  useEffect(() => { if (disabled) panel.current.hidePopover(); }, [disabled]);
  useEffect(() => { setPreset(nativeModel?.preset ?? ''); }, [nativeModel?.preset]);
  useEffect(() => { setPreview(undefined); setError(''); }, [source, selectedModel, effort]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    latest.current.call('provider.presets', {}).then(result => { if (!cancelled) setPresets(result.presets); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    if (!open || (agentId === 'jolo' && !preset)) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError('');
    latest.current.call(agent ? 'agent.models' : 'provider.models', agent ? { agentId, refresh: Boolean(refresh) } : { preset, refresh: Boolean(refresh) })
      .then(result => { if (!cancelled) setReports(current => ({ ...current, [source]: result })); })
      .catch(error => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, source, refresh]);
  const dismiss = () => { panel.current.hidePopover(); trigger.current?.focus(); };
  const save = async (model, nextEffort, nextView = view) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    try { await onSave({ agentId, preset, model: model || null, effort: nextEffort || null }); if (alive.current) setView(nextView); }
    catch (error) { if (alive.current) setError(error.message); }
    finally { busy.current = false; if (alive.current) { setSaving(false); setPreview(undefined); } }
  };
  const commit = event => {
    const next = steps[Number(event.currentTarget.value)];
    if (next !== (effort ?? null)) void save(selectedModel, next);
    else setPreview(undefined);
  };
  const choices = report?.models ?? [];
  const canModel = !agent || agent.supportsModel;
  const currentLabel = agent ? chosen?.displayName ?? agent.model ?? agentName : reports[`provider:${nativeModel?.preset}`]?.models.find(model => model.id === nativeModel?.model)?.displayName ?? nativeModel?.model ?? 'Choose model';
  return <>
    <button ref={trigger} type="button" className="model-select" aria-label="Choose model and effort" aria-haspopup="dialog" aria-expanded={open} popoverTarget={id} disabled={disabled} title={`${agentName} · ${modelLabel(currentLabel)} · ${effortLabel(effort)}`} onClick={() => {
      const rect = trigger.current.getBoundingClientRect(), element = panel.current;
      element.style.left = `${Math.max(8, Math.min(rect.left - 8, innerWidth - 272))}px`;
      element.style.bottom = `${Math.max(8, innerHeight - rect.top + 10)}px`;
      element.style.maxHeight = `${Math.max(110, rect.top - 18)}px`;
    }}><ModelLogo model={selectedModel} agentId={agentId} preset={nativeModel?.preset} /><span>{modelLabel(currentLabel)}</span>{effort && <small>{effortLabel(effort)}</small>}<Icon name="down" size={12} /></button>
    <div ref={panel} id={id} className="model-popover" popover="auto" role="dialog" aria-label="Model and reasoning effort" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      // Enter in a popover must never submit the surrounding message composer.
      if (event.key === 'Enter') { event.stopPropagation(); if (event.target instanceof HTMLInputElement) event.preventDefault(); }
      if (event.key === 'Tab') {
        const items = [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
        if ((event.shiftKey && document.activeElement === items[0]) || (!event.shiftKey && document.activeElement === items.at(-1))) dismiss();
      }
    }}>
      {view === 'effort' ? <>
        <div className="effort-heading"><Icon name="bolt" size={18} /><button type="button" className="effort-model" disabled={saving} onClick={() => setView('models')}><strong>{effortLabel(shownEffort)}<Icon name="chevron" size={13} /></strong><span title={modelLabel(label)}>{modelLabel(label)}</span></button><button type="button" className="effort-reset" title="Reset effort to default" aria-label="Reset effort to default" disabled={saving || !effort} onClick={() => save(selectedModel, null)}><Icon name="refresh" size={17} /></button></div>
        {levels.length > 0 ? <div className="effort-control">
          <div className="effort-slider" style={/** @type {import('react').CSSProperties} */ ({ '--progress': index / (steps.length - 1) })}>
            <div className="effort-track" aria-hidden="true" /><div className="effort-ticks" aria-hidden="true">{steps.map((step, i) => <span key={step ?? 'default'} className={i <= index ? 'filled' : ''} />)}</div>
            <input type="range" min="0" max={steps.length - 1} step="1" value={index} disabled={saving || loading} aria-label="Reasoning effort" aria-valuetext={effortLabel(shownEffort)} onChange={event => setPreview(steps[Number(event.target.value)])} onPointerUp={commit} onPointerCancel={() => setPreview(undefined)} onBlur={commit} onKeyUp={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) commit(event); }} />
          </div><div className="effort-scale"><span>Default</span><span>{effortLabel(levels.at(-1))}</span></div>
        </div> : <p className="model-status" role="status">{loading ? 'Loading effort levels…' : !report && !agent ? 'Choose a connected model to get started.' : report?.note ?? 'Effort levels aren’t reported for this model.'}</p>}
        <div className="model-popover-footer"><button type="button" disabled={saving} onClick={() => setView('models')}>{agentName}<Icon name="down" size={12} /></button><span>{saving ? 'Saving…' : agent ? 'Agent defaults' : hasSession ? 'Current task' : 'Jolo defaults'}</span><button type="button" aria-label="Model settings" title="Model settings" onClick={() => { dismiss(); onSettings(agent ? 'agents' : 'provider'); }}><Icon name="settings" size={15} /></button></div>
      </> : <>
        <div className="model-list-heading"><button type="button" aria-label="Back to effort" onClick={() => setView('effort')}><Icon name="back" size={16} /></button><strong>Choose model</strong><button type="button" aria-label="Refresh models" title="Refresh models" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={15} /></button></div>
        <div className="model-source"><Select aria-label="Answering agent" value={agentId} disabled={saving} onChange={event => { setPreview(undefined); onAgent(event.target.value); }}><option value="jolo">Jolo</option>{agents.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.available}>{entry.displayName}{!entry.available ? ' · Not installed' : ''}</option>)}</Select>{!agent && <Select aria-label="Model provider" value={preset} disabled={saving} onChange={event => setPreset(event.target.value)}>{!preset && <option value="">Choose provider</option>}{presets.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.available}>{entry.displayName}{!entry.available ? ' · Connect in Settings' : ''}</option>)}</Select>}</div>
        <div className="model-choices" role="group" aria-label="Available models">
          {agent && canModel && <button type="button" aria-pressed={!selectedModel} disabled={saving} onClick={() => save(null, null, 'effort')}><span><strong>Default</strong><small>{agentName} chooses the model</small></span>{!selectedModel && <Icon name="check" size={15} />}</button>}
          {choices.map(model => <button type="button" key={model.id} data-model={model.id} aria-pressed={selectedModel === model.id} disabled={saving || !canModel} onClick={() => save(model.id, effortForModel(report, model.id, effort), 'effort')}><span><strong>{modelLabel(model.displayName || model.id)}</strong></span>{selectedModel === model.id && <Icon name="check" size={15} />}</button>)}
          {loading && <p className="model-status" role="status">Loading models…</p>}
          {!loading && !choices.length && <p className="model-status">{report?.note ?? 'No models reported. Configure this agent in Settings.'}</p>}
        </div>
      </>}
      {error && <p className="model-error" role="alert">{error}</p>}
    </div>
  </>;
}
