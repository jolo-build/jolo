import { useEffect, useState } from 'react';
import { engineCall } from '../engine-context.jsx';
import { Icon } from './icon.jsx';

const finished = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export function DelegatedTasks({ sessionId, working, onOpenSession }) {
  const [tasks, setTasks] = useState([]), [error, setError] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    let live = true, timer, hasTasks = tasks.length > 0;
    const refresh = async () => {
      try {
        const { delegations } = await engineCall('delegation.list', { sessionId });
        if (!live) return;
        hasTasks = delegations.length > 0;
        setTasks(delegations); setError('');
        if (working || delegations.some(task => !finished.has(task.state))) timer = setTimeout(refresh, 1500);
      } catch (failure) {
        if (!live) return;
        if (hasTasks) setError(failure.message);
        if (working || hasTasks) timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [sessionId, working]);
  if (!tasks.length) return null;
  return <section className="delegated-tasks" aria-label="Child tasks">
    <div className="delegated-heading">Child tasks</div>
    {tasks.map(task => <div className="delegated-task" key={task.id}>
      <button type="button" className="delegated-open" onClick={() => onOpenSession?.(task.sessionId)} title="Open child conversation">
        <Icon name={task.state === 'completed' ? 'check' : finished.has(task.state) ? 'circle' : 'spinner'} size={14} />
        <span><strong>{task.title}</strong><small>{task.execution?.model} · {task.execution?.preset ?? task.execution?.agentId} · {task.state.replaceAll('_', ' ')}</small></span>
      </button>
      {!finished.has(task.state) && <button type="button" onClick={async () => {
        try {
          const { delegation } = await engineCall('delegation.call', { runId: task.parentRunId, name: 'delegation_cancel', arguments: { delegationId: task.id } });
          setTasks(current => current.map(item => item.id === task.id ? delegation : item));
        } catch (failure) { setError(failure.message); }
      }}>Stop</button>}
      {task.failure && <p className="delegated-error">{task.failure}</p>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
