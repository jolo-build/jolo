import { useEffect, useRef, useState } from 'react';
import { AgentLogo } from './brand.jsx';
import { Icon } from './icon.jsx';
import { basename } from '../presentation.js';
import { readLastModelChoice, rememberModelChoice } from '../last-model-choice.js';
import { FIRST_TASKS, onboardingAgentAvailable, preferredOnboardingAgent } from '../onboarding.js';

const steps = ['Choose an agent', 'Open a project', 'Try a first task'];

export function Onboarding({ connected, active, settings, project, call, onSettings, onOpenFolder, onFinish, onDismiss }) {
  const [step, setStep] = useState(0);
  const [connections, setConnections] = useState(null);
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState(true);
  const [selection, setSelection] = useState(null);
  const [task, setTask] = useState(FIRST_TASKS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const heading = useRef(null);
  const working = useRef(false);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (!connected || !active) return;
    let live = true;
    setChecking(true); setError(null);
    Promise.all([call('agent.catalog', {}), call('provider.presets', {})]).then(([catalog, providers]) => {
      if (live) setConnections({ agents: catalog.agents.filter(agent => agent.transport !== 'pty'), presets: providers.presets });
    }).catch(error => { if (live) { setConnections(null); setError(error.message); } }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [call, connected, active, settings, revision]);
  const agents = connections?.agents ?? [];
  const presets = connections?.presets ?? [];
  const saved = readLastModelChoice();
  const model = saved?.model ?? settings?.model;
  const choice = selection ?? preferredOnboardingAgent(agents, model, presets, saved);
  const available = connected && !checking && onboardingAgentAvailable(choice, agents, model, presets);
  const nativeAvailable = onboardingAgentAvailable('jolo', agents, model, presets);
  const folder = project && !project.standalone ? project : null;
  const selectedTask = FIRST_TASKS.find(item => item.id === task) ?? FIRST_TASKS[0];
  const agentName = choice === 'jolo' ? model?.model ?? 'API provider' : agents.find(agent => agent.id === choice)?.displayName;
  const perform = async operation => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(null);
    try { await operation(); } catch (error) { setError(error.message); }
    finally { working.current = false; setBusy(false); }
  };
  const next = () => {
    if (step === 0 && available) { rememberModelChoice(choice, model); setStep(1); }
    else if (step === 1 && folder) setStep(2);
    else if (step === 2 && folder && available) void perform(() => onFinish(selectedTask.prompt, choice, model));
  };
  return <section className="onboarding" aria-label="Getting started">
    <div className="onboarding-content">
      <header className="onboarding-heading"><span className="onboarding-eyebrow">Welcome to Jolo</span><h1>Make your first task a useful one.</h1><p>Bring your coding agent, open a project, and explore it together.</p></header>
      <ol className="onboarding-steps" aria-label="Setup progress">{steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className={index < step ? 'complete' : ''}><span>{index < step ? <Icon name="check" size={13} /> : index + 1}</span>{label}</li>)}</ol>
      <div className="onboarding-card">
        <h2 ref={heading} tabIndex={-1}>{steps[step]}</h2>
        {step === 0 && <>
          <p className="onboarding-description">Jolo uses your existing agent installation and subscription, or an API provider you connect.</p>
          {checking && connected ? <p className="onboarding-note" role="status">Checking installed agents and providers…</p> : <>
            <fieldset className="onboarding-options" disabled={busy || !connected}><legend className="sr-only">Agent for your first task</legend>
              {agents.map(agent => <label key={agent.id} className={`onboarding-option${!agent.available ? ' unavailable' : ''}`}>
                <input type="radio" name="onboarding-agent" value={agent.id} checked={choice === agent.id} disabled={!agent.available} onChange={() => setSelection(agent.id)} />
                <AgentLogo agentId={agent.id} /><span><strong>{agent.displayName}</strong><small>{agent.available ? 'Installed' : 'Not detected'}</small></span>
              </label>)}
              <label className="onboarding-option"><input type="radio" name="onboarding-agent" value="jolo" checked={choice === 'jolo'} onChange={() => setSelection('jolo')} /><Icon name="think" size={20} /><span><strong>Use an API provider</strong><small>{nativeAvailable ? model.model : 'Connect a provider in Settings'}</small></span></label>
            </fieldset>
            <p className="onboarding-note">{agents.some(agent => agent.available) ? 'Installed agents use their own login. Make sure you have signed in to the agent before your first task.' : 'No coding agents detected. Install and sign in to an agent, then check again, or connect an API provider.'}</p>
          </>}
          <div className="onboarding-links"><button type="button" disabled={busy || checking || !connected} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" size={14} />Check again</button><button type="button" disabled={busy || !connected} onClick={() => { setSelection('jolo'); onSettings('provider'); }}>Set up API provider<Icon name="right" size={13} /></button><button type="button" disabled={busy} onClick={() => void perform(() => window.jolo.openExternal('https://docs.jolo.build/agents'))}>Agent setup guide<Icon name="right" size={13} /></button></div>
        </>}
        {step === 1 && <>
          <p className="onboarding-description">Choose a project you want to understand or improve. Your first task will use the files in that folder.</p>
          <div className="onboarding-folder"><Icon name="folderOpen" size={28} /><div><strong>{folder ? basename(folder.rootPath) : 'Choose a project folder'}</strong><p title={folder?.rootPath}>{folder?.rootPath ?? 'A small project is a good place to start.'}</p></div><button type="button" className="outline" disabled={busy || !connected} onClick={() => void perform(onOpenFolder)}>{busy ? 'Opening…' : folder ? 'Change folder' : 'Choose folder'}</button></div>
          <p className="onboarding-note">You can use local projects without a Jolo account.</p>
        </>}
        {step === 2 && <>
          <p className="onboarding-description">Start with a question about {folder ? basename(folder.rootPath) : 'your project'}. You can edit the message before sending it to {agentName ?? 'your agent'}.</p>
          <fieldset className="onboarding-tasks" disabled={busy}><legend className="sr-only">First task</legend>{FIRST_TASKS.map(item => <label className="onboarding-option" key={item.id}><input type="radio" name="onboarding-task" checked={task === item.id} value={item.id} onChange={() => setTask(item.id)} /><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}</fieldset>
          <div className="onboarding-prompt"><span>Message preview</span><p>{selectedTask.prompt}</p></div>
          {!available && <p className="onboarding-note">Go back to choose an available agent or configure a provider.</p>}
        </>}
        {!connected && <p className="onboarding-note" role="status">Waiting for the local engine to connect…</p>}
        {error && <p className="onboarding-error" role="alert">{error}</p>}
        <footer className="onboarding-actions"><button type="button" onClick={() => { setError(null); setStep(value => value - 1); }} disabled={busy || step === 0}><Icon name="back" size={14} />Back</button><button type="button" className="primary" onClick={next} disabled={busy || !connected || (step === 0 ? !available : step === 1 ? !folder : !folder || !available)}>{busy && step === 2 ? 'Opening draft…' : step === 2 ? 'Open task draft' : 'Continue'}<Icon name="right" size={14} /></button></footer>
      </div>
      <div className="onboarding-footer"><span>Your agent and model choice will carry over to new tasks.</span><button type="button" disabled={busy} onClick={onDismiss}>Skip for now</button></div>
    </div>
  </section>;
}
