import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Model and effort already live in engine settings. The terminal only needs to
// remember which agent's settings to use for its next fresh draft.
export function createModelChoiceStore({ dataDir }) {
  const file = path.join(dataDir, 'cli', 'model-choice.json');
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        return value?.version === 1 && typeof value.agentId === 'string' ? value.agentId : null;
      } catch { return null; }
    },
    write(agentId) {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, agentId: agentId ?? null }) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
  };
}

export async function restoreModelAgent(client, store) {
  const agentId = store.read();
  if (!agentId) return null;
  try {
    const { agents } = await client.call('agent.catalog', {});
    return agents.some(agent => agent.id === agentId && agent.available && agent.transport && agent.transport !== 'pty') ? agentId : null;
  } catch { return null; }
}
