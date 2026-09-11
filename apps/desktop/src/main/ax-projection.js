// Accessibility snapshot projection: compact tree with element references.
// Drops inline text boxes, folds duplicate sole text children, and elides unnamed generic wrappers.

const STATE_PROPERTIES = new Set(["disabled", "checked", "selected", "expanded", "pressed", "readonly", "required", "focused", "invalid"]);
const WRAPPER_ROLES = new Set(["generic", "none", "presentation"]);

/**
 * One node as this projection emits it. States and a value are written only when the page has them,
 * so a node that is neither stateful nor a field carries just its reference, its role, and its name.
 * @typedef {{
 *   ref: string,
 *   parentRef?: string,
 *   role: string,
 *   name: string,
 *   states?: Record<string, unknown>,
 *   value?: string,
 * }} ProjectedNode
 */

/**
 * @param {any[]} nodes raw Accessibility.getFullAXTree nodes
 * @param {{ snapshotId: string, navigationRevision: number, referenceStart?: number, maxNodes?: number, maxBytes?: number }} options
 *   `referenceStart` continues the host's reference numbering, so references stay unique across snapshots;
 *   a caller projecting a tree on its own starts from zero.
 */
export function projectAX(nodes, options) {
  const maxNodes = options.maxNodes ?? 300;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const references = new Map();
  const snapshot = { snapshotId: options.snapshotId, navigationRevision: options.navigationRevision, truncated: false, nodes: [] };
  const seen = new Set();
  let bytes = 0;
  const role = (node) => node?.role?.value ?? "";
  const name = (node) => node?.name?.value ?? "";
  const visibleChildren = (node) => (node?.childIds ?? []).map((id) => byId.get(id)).filter((n) => n && !n.ignored && role(n) !== "InlineTextBox");

  function visit(node, parentRef) {
    if (!node || seen.has(node.nodeId) || snapshot.truncated) return;
    seen.add(node.nodeId);
    const r = role(node);
    if (r === "InlineTextBox") return;
    if (node.ignored || (WRAPPER_ROLES.has(r) && !name(node))) {
      for (const child of node.childIds ?? []) visit(byId.get(child), parentRef);
      return;
    }
    const parent = byId.get(node.parentId);
    if (r === "StaticText" && parent && !parent.ignored && visibleChildren(parent).length === 1 && name(parent) === name(node) && name(node)) return;
    const ref = `e${(options.referenceStart ?? 0) + snapshot.nodes.length + 1}`;
    /** @type {ProjectedNode} */
    const output = { ref, ...(parentRef ? { parentRef } : {}), role: r, name: name(node).slice(0, 200) };
    /** @type {Record<string, unknown>} */
    const states = {};
    for (const property of node.properties ?? []) if (STATE_PROPERTIES.has(property.name)) states[property.name] = property.value?.value;
    if (Object.keys(states).length) output.states = states;
    if (node.value?.value !== undefined && node.value.value !== "") output.value = String(node.value.value).slice(0, 200);
    const cost = JSON.stringify(output).length + 1;
    if (snapshot.nodes.length >= maxNodes || bytes + cost > maxBytes) { snapshot.truncated = true; return; }
    snapshot.nodes.push(output);
    bytes += cost;
    if (node.backendDOMNodeId) references.set(ref, node.backendDOMNodeId);
    for (const child of node.childIds ?? []) visit(byId.get(child), ref);
  }
  for (const node of nodes) if (!byId.has(node.parentId)) visit(node, null);
  return { snapshot, references };
}
