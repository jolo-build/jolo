import { z } from 'zod';
import { delegationTools } from '../tools/delegation.js';

/** How much longer than a tool's deadline the bridge waits for it, so the engine's answer at that deadline still arrives. */
const REPLY_MARGIN_MS = 5_000;

export const delegationBridge = {
  tools: delegationTools.map(tool => {
    const inputSchema = z.toJSONSchema(tool.params); delete inputSchema.$schema;
    return { name: tool.name, description: tool.description, inputSchema, annotations: { readOnlyHint: tool.executionClass === 'read', openWorldHint: false } };
  }),
  async call(client, workspaceId, params) {
    const tool = delegationTools.find(tool => tool.name === params?.name);
    if (!tool) throw new Error('Unknown delegation tool');
    // The bridge's connection gives up on a call after about a minute; a delegation_status wait may take far longer.
    const value = await client.call('delegation.call', { workspaceId, name: tool.name, arguments: tool.params.parse(params.arguments ?? {}) }, { timeoutMs: tool.deadlineMs + REPLY_MARGIN_MS });
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
  },
};
