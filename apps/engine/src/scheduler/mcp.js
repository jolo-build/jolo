// The schedule tools a hosted agent sees: the same definitions the native loop registers, with
// each call forwarded to the scoped RPC — the credential names the caller's own task.
import { z } from 'zod';
import { parseEveryMs } from '@jolo/protocol';
import { scheduleTools } from '../tools/schedules.js';

export const SCHEDULE_METHODS = ['schedule.create', 'schedule.list', 'schedule.pause', 'schedule.resume', 'schedule.cancel'];

const toRpc = {
  schedule_create: (args) => {
    const everyMs = parseEveryMs(args.every);
    if (!everyMs) throw new Error(`unrecognized interval "${args.every}" — use e.g. "15m", "1h", "1d"`);
    return ['schedule.create', { prompt: args.prompt, everyMs }];
  },
  schedule_list: () => ['schedule.list', {}],
  schedule_pause: (args) => ['schedule.pause', { scheduleId: args.scheduleId }],
  schedule_resume: (args) => ['schedule.resume', { scheduleId: args.scheduleId }],
  schedule_cancel: (args) => ['schedule.cancel', { scheduleId: args.scheduleId }],
};

export const scheduleBridge = {
  tools: scheduleTools.map(tool => {
    const inputSchema = z.toJSONSchema(tool.params); delete inputSchema.$schema;
    return { name: tool.name, description: tool.description, inputSchema, annotations: { readOnlyHint: tool.executionClass === 'read', openWorldHint: false } };
  }),
  async call(client, workspaceId, params) {
    const map = toRpc[params?.name];
    const tool = scheduleTools.find(tool => tool.name === params?.name);
    if (!map || !tool) throw new Error('unknown schedule tool');
    const [method, extra] = map(tool.params.parse(params.arguments ?? {}));
    const value = await client.call(method, { workspaceId, ...extra });
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
  },
};
