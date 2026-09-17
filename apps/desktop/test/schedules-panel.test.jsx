import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SchedulesPanel } from '../src/renderer/components/schedules-panel.jsx';

const stamp = new Date().toISOString();
const schedule = (over = {}) => ({
  id: 'sch_1', sessionId: 'ses_1', prompt: 'check the board', everyMs: 900_000, state: 'active',
  fireCount: 2, nextFireAt: new Date(Date.now() + 12 * 60_000).toISOString(), lastRunId: 'run_1',
  lastError: null, createdAt: stamp, updatedAt: stamp, ...over,
});

test('a task’s heartbeats list with state, interval, and per-row actions', () => {
  const html = renderToStaticMarkup(<SchedulesPanel sessionId="ses_1" schedules={[schedule(), schedule({ id: 'sch_2', state: 'paused', prompt: 'paused beat', fireCount: 0 })]} call={async () => {}} refresh={async () => []} />);
  expect(html).toContain('Heartbeats');
  expect(html).toContain('check the board');
  expect(html).toContain('every 15m');
  expect(html).toContain('next in 12m');
  expect(html).toContain('fired 2');
  expect(html).toContain('>Pause</button>');
  expect(html).toContain('>Resume</button>');
  expect(html).toContain('>Cancel</button>');
});

test('a schedule error is shown on its row', () => {
  const html = renderToStaticMarkup(<SchedulesPanel sessionId="ses_1" schedules={[schedule({ lastError: 'a check-in was already in progress' })]} call={async () => {}} refresh={async () => []} />);
  expect(html).toContain('a check-in was already in progress');
});

test('an empty task explains how heartbeats are set; no task says to open one', () => {
  const empty = renderToStaticMarkup(<SchedulesPanel sessionId="ses_1" schedules={[]} call={async () => {}} refresh={async () => []} />);
  expect(empty).toContain('No heartbeats on this task');
  expect(empty).toContain('New heartbeat');
  const none = renderToStaticMarkup(<SchedulesPanel sessionId={null} schedules={[]} call={async () => {}} refresh={async () => []} />);
  expect(none).toContain('Open a task to give it a heartbeat');
  expect(none).not.toContain('New heartbeat');
});
