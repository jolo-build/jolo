import { z } from 'zod';
import { delegationTools } from '../tools/delegation.js';

export const delegationBridge = {
  tools: delegationTools.map(tool => {
    const inputSchema = z.toJSONSchema(tool.params); delete inputSchema.$schema;
    return { name: tool.name, description: tool.description, inputSchema, annotations: { readOnlyHint: tool.executionClass === 'read', openWorldHint: false } };
  }),
  async call(client, workspaceId, params) {
    const tool = delegationTools.find(tool => tool.name === params?.name);
    if (!tool) throw new Error('Unknown delegation tool');
    const value = await client.call('delegation.call', { workspaceId, name: tool.name, arguments: tool.params.parse(params.arguments ?? {}) });
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
  },
};
