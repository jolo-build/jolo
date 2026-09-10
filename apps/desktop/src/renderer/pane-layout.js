// Layout metadata only: conversations stay mounted as stable siblings when a split changes.
export const MAX_PANES = 12;
export const initialLayout = () => ({ tree: { id: "pane-1" }, panes: [{ id: "pane-1" }], active: "pane-1", zoom: null });
const transform = (node, id, update) => node.id === id ? update(node) : node.children ? { ...node, children: node.children.map((child) => transform(child, id, update)) } : node;
function remove(node, id) {
  if (node.id === id) return null;
  if (!node.children) return node;
  const children = node.children.map((child) => remove(child, id)).filter(Boolean);
  return children.length === 1 ? children[0] : { ...node, children };
}
export function paneReducer(state, action) {
  switch (action.type) {
    case "focus": return state.panes.some((pane) => pane.id === action.id) && state.active !== action.id ? { ...state, active: action.id } : state;
    case "split": {
      if (state.panes.length >= MAX_PANES || !state.panes.some((pane) => pane.id === action.source) || state.panes.some((pane) => pane.id === action.id)) return state;
      const tree = transform(state.tree, action.source, (leaf) => ({ id: `split-${action.id}`, axis: action.axis === "y" ? "y" : "x", ratio: .5, children: action.before ? [{ id: action.id }, leaf] : [leaf, { id: action.id }] }));
      return { tree, panes: [...state.panes, { id: action.id, path: action.path ?? null, ...(action.task ? { task: action.task } : {}), ...(action.newChat ? { newChat: true } : {}) }], active: action.id, zoom: null };
    }
    case "close": {
      if (state.panes.length === 1 || !state.panes.some((pane) => pane.id === action.id)) return state;
      const index = state.panes.findIndex((pane) => pane.id === action.id);
      const panes = state.panes.filter((pane) => pane.id !== action.id);
      return { tree: remove(state.tree, action.id), panes, active: state.active === action.id ? panes[Math.max(0, index - 1)].id : state.active, zoom: state.zoom === action.id ? null : state.zoom };
    }
    case "resize": return Number.isFinite(action.ratio) ? { ...state, tree: transform(state.tree, action.id, (node) => node.children ? { ...node, ratio: Math.max(.15, Math.min(.85, action.ratio)) } : node) } : state;
    case "zoom": return state.panes.some((pane) => pane.id === action.id) ? { ...state, active: action.id, zoom: state.zoom === action.id ? null : action.id } : state;
    default: return state;
  }
}
export function paneRects(tree, rect = { x: 0, y: 0, width: 100, height: 100 }, result = { panes: {}, dividers: [] }) {
  if (!tree.children) { result.panes[tree.id] = rect; return result; }
  const horizontal = tree.axis === "x";
  const size = horizontal ? "width" : "height";
  const origin = horizontal ? "x" : "y";
  const first = { ...rect, [size]: rect[size] * tree.ratio };
  const second = { ...rect, [origin]: rect[origin] + first[size], [size]: rect[size] - first[size] };
  result.dividers.push({ id: tree.id, axis: tree.axis, ratio: tree.ratio, rect, position: second[origin] });
  paneRects(tree.children[0], first, result);
  paneRects(tree.children[1], second, result);
  return result;
}
