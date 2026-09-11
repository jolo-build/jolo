// Exercise the real scoped MCP child advertised to a hosted vendor fixture.
/**
 * @param {{ command: string, args: string[] }} config the browser server as the vendor advertised it
 * @param {(result: any) => void} [onResult] receives the decoded screenshot tool result, so a
 *   fixture that reports tool output back to the engine can forward it verbatim.
 */
export async function browserMcpCheck(config, onResult = () => {}) {
  if (!config?.command) throw new Error('browser MCP was not configured');
  const child = Bun.spawn([config.command, ...config.args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pending = new Map();
  let sequence = 0;
  const reader = (async () => {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const entry = pending.get(response.id); pending.delete(response.id);
        if (response.error) entry?.reject(new Error(response.error.message)); else entry?.resolve(response.result);
      }
    }
  })();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); child.stdin.flush();
  });
  const timer = setTimeout(() => { for (const entry of pending.values()) entry.reject(new Error('browser MCP timed out')); child.kill(); }, 15_000);
  try {
    await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} });
    const list = await request('tools/list', {});
    if (!list.tools.some(tool => tool.name === 'browser_fill')) throw new Error('browser tools missing');
    const tabs = await request('tools/call', { name: 'browser_tabs', arguments: {} });
    let tab = tabs.structuredContent?.tabs[0];
    if (!tab && tabs.structuredContent?.canOpen) {
      const opened = await request('tools/call', { name: 'browser_open', arguments: {} });
      if (opened.isError) throw new Error(opened.content[0].text);
      tab = opened.structuredContent;
    }
    if (!tab) return 'No browser attached';
    const snapshot = await request('tools/call', { name: 'browser_snapshot', arguments: { tabId: tab.tabId } });
    if (snapshot.isError) throw new Error(snapshot.content[0].text);
    const action = await request('tools/call', { name: 'browser_fill', arguments: { tabId: tab.tabId, ref: 'e2', text: 'hosted browser input' } });
    if (action.isError) throw new Error(action.content[0].text);
    const shot = await request('tools/call', { name: 'browser_screenshot', arguments: { tabId: tab.tabId } });
    onResult(shot);
    if (shot.isError || !shot.content.some(part => part.type === 'image' && part.mimeType === 'image/png' && part.data.length > 10)) throw new Error('screenshot did not reach the model as an image');
    const bad = await request('tools/call', { name: 'browser_navigate', arguments: { url: 'file:///etc/passwd' } });
    if (!bad.isError) throw new Error('unsafe scheme admitted');
    return 'Browser controlled; screenshot received as an image';
  } finally { clearTimeout(timer); child.stdin.end(); await child.exited; await reader; }
}
