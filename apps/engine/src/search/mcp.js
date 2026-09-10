// A scoped stdio bridge for hosted agents. Search and index ownership remain in the Jolo engine.
import { readFileSync } from 'node:fs';
import { connect } from '@jolo/client';
import { SearchTextParams } from '@jolo/protocol';
import { z } from 'zod';

export async function runSearchMcp(argv = process.argv.slice(3)) {
  const inputSchema = z.toJSONSchema(SearchTextParams); delete inputSchema.$schema;
  return runScopedMcp({ argv, name: 'jolo-search', tools: [{ name: 'search_text', description: 'Search this workspace using Jolo’s live tgrep index, with automatic live-search fallback while indexing. Literal by default. Set fresh=true when verifying recent edits. Returns bounded file paths, line numbers, text, and a paging cursor.', inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }],
    async call(client, workspaceId, params) {
      if (params?.name !== 'search_text') throw new Error('unknown search tool');
      const args = SearchTextParams.parse(params.arguments ?? {});
      const value = await client.call('workspace.search', { ...args, workspaceId });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
    },
  });
}

/** Bounded stdio transport shared by workspace-scoped hosted tool servers. */
export async function runScopedMcp({ argv, name, tools, call }) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i]] = argv[i + 1];
  const workspaceId = flags['--workspace'];
  if (!workspaceId || !flags['--socket'] || !flags['--token-file']) throw new Error(`${name} requires --workspace, --socket, and --token-file`);
  const client = await connect({ socketPath: flags['--socket'], token: readFileSync(flags['--token-file'], 'utf8').trim(), clientKind: 'headless', build: name, requestTimeoutMs: 65_000 });
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const inflight = new Set();
  const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
  const handle = async request => {
    if (request.id === undefined) return;
    let result;
    switch (request.method) {
      case 'initialize': result = { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : versions.at(-1), capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        try { result = await call(client, workspaceId, request.params); }
        catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
        break;
      }
      default: send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return;
    }
    send({ jsonrpc: '2.0', id: request.id, result });
  };
  let pending = '';
  const decoder = new TextDecoder();
  const stop = () => { client.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    for await (const chunk of process.stdin) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error('MCP input exceeds limit');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
        if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue; }
        if (inflight.size >= 4) await Promise.race(inflight);
        const task = handle(request).catch(error => send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32603, message: error.message } })).finally(() => inflight.delete(task));
        inflight.add(task);
      }
    }
    await Promise.all(inflight);
  } finally { await client.close(); }
}
