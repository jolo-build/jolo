// A scripted browser host speaking the same socket protocol as the Electron main process.
// Answers every browser operation from fixed data so engine suites can drive the broker end to end.
import { BROWSER_OPERATIONS } from '@jolo/protocol';

// 1x1 transparent PNG
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * @param {any} engine a started test engine
 * @param {string} workspaceId
 * @param {string} [behaviour] `ok` answers at once; `vanish` drops the connection on the first
 *   operation; `closed` registers only when the engine asks it to open the pane.
 */
export async function scriptedHost(engine, workspaceId, behaviour = 'ok') {
  const client = await engine.connect({ clientKind: "desktop" });
  const received = [];
  let navigationRevision = 1;
  client.onNotification("browser.execute", async (params) => {
    received.push(params);
    const reply = (body) => client.call("browser.result", { invocationId: params.invocationId, ...body });
    if (behaviour === "vanish") { await client.close(); return; }
    const args = params.arguments;
    const screenshot = { base64: PNG_BASE64, width: 1, height: 1, mimeType: "image/png" };
    switch (params.operation) {
      case "navigate": navigationRevision += 1; return reply({ status: "ok", result: { url: args.url, title: "Fixture", navigationRevision }, navigationRevision });
      case "snapshot": return reply({ status: "ok", result: { snapshotId: `snap_${navigationRevision}`, navigationRevision, truncated: false, nodes: [{ ref: "e1", role: "RootWebArea", name: "Fixture" }, { ref: "e2", parentRef: "e1", role: "button", name: "Click" }] } });
      case "click": return reply({ status: args.ref === "e2" ? "ok" : "error", ...(args.ref === "e2" ? { result: { ref: "e2", x: 10, y: 10, navigationRevision } } : { error: { code: "unknown_reference", message: `unknown reference ${args.ref}` } }) });
      case "screenshot": return reply({ status: "ok", result: { url: "http://fixture/", navigationRevision, scale: 1, viewport: { width: 1, height: 1 } }, screenshot });
      case "zoom": return reply({ status: "ok", result: { url: "http://fixture/", navigationRevision, region: [args.x0, args.y0, args.x1, args.y1], scale: 2 }, screenshot });
      case "pointer": return reply({ status: "ok", result: { action: args.action, x: args.x, y: args.y, navigationRevision, url: "http://fixture/" } });
      case "wait": return reply({ status: "ok", result: { waitedMs: args.ms, navigationRevision, url: "http://fixture/" } });
      case "type": case "fill": return reply({ status: "ok", result: { ...(args.ref ? { ref: args.ref } : {}), typed: args.text.length, submitted: Boolean(args.submit), navigationRevision } });
      case "press": case "scroll": return reply({ status: "ok", result: { navigationRevision, url: "http://fixture/" } });
      case "network": return reply({ status: "ok", result: { navigationRevision, url: "http://fixture/", entries: [{ method: "GET", url: "http://fixture/", status: 200, type: "Document", size: 120 }], truncated: false } });
      default: return reply({ status: "error", error: { code: "unsupported", message: params.operation } });
    }
  });
  let capabilityId;
  const register = async () => { ({ capabilityId } = await client.call("browser.register", { workspaceId, tabId: "tab_1", navigationRevision, url: "about:blank", title: "", operations: [...BROWSER_OPERATIONS] })); };
  if (behaviour === 'closed') {
    client.onNotification('browser.open', async params => {
      received.push({ operation: 'open' });
      await register();
      await client.call('browser.openResult', { invocationId: params.invocationId, capabilityId });
    });
    await client.call('browser.setOpener', { workspaceIds: [workspaceId] });
  } else await register();
  return { client, received, get capabilityId() { return capabilityId; } };
}
