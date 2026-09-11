import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Notices } from "./components/notices.jsx";
import { EngineProvider } from "./engine-context.jsx";
import { WorkspacePane } from "./components/workspace-pane.jsx";
import { initialLayout, MAX_PANES, paneRects, paneReducer } from "./pane-layout.js";
import { browserTarget } from './browser-target.js';
import { TaskDragContext, TASK_DRAG_TYPE, taskDropSide } from './task-drag.jsx';
import { readSidebar, sidebarWidth, sidebarLimit, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_KEY } from './sidebar-layout.js';

function SidebarDivider({ width, maximum, onResize, onDragging }) {
  const drag = useRef(null);
  const finish = () => { drag.current = null; onDragging(false); };
  return <div className="sidebar-divider" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN} aria-valuemax={maximum} aria-valuenow={width} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width }; onDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (drag.current) onResize(drag.current.width + event.clientX - drag.current.x); }}
    onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={() => onResize(SIDEBAR_DEFAULT)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); onResize(event.key === 'Home' ? SIDEBAR_MIN : event.key === 'End' ? maximum : width + (event.key === 'ArrowLeft' ? -16 : 16));
    }} />;
}

function Divider({ divider, canvas, onResize }) {
  const drag = useRef(null);
  const horizontal = divider.axis === "x";
  const { rect } = divider;
  const update = (event) => {
    if (!drag.current) return;
    const bounds = canvas.current.getBoundingClientRect();
    const offset = horizontal ? event.clientX - bounds.left : event.clientY - bounds.top;
    const length = horizontal ? bounds.width : bounds.height;
    const origin = rect[horizontal ? "x" : "y"] * length / 100;
    const span = rect[horizontal ? "width" : "height"] * length / 100;
    onResize(divider.id, (offset - origin) / span);
  };
  return <div className={`pane-divider ${horizontal ? "vertical" : "horizontal"}`} role="separator" aria-label={horizontal ? "Resize columns" : "Resize rows"} aria-orientation={horizontal ? "vertical" : "horizontal"} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(divider.ratio * 100)} tabIndex={0}
    style={horizontal ? { left: `${divider.position}%`, top: `${rect.y}%`, height: `${rect.height}%` } : { top: `${divider.position}%`, left: `${rect.x}%`, width: `${rect.width}%` }}
    onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); drag.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={update} onPointerUp={(event) => { update(event); drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={() => onResize(divider.id, .5)}
    onKeyDown={(event) => {
      const backward = horizontal ? "ArrowLeft" : "ArrowUp", forward = horizontal ? "ArrowRight" : "ArrowDown";
      if (![backward, forward, "Home", "End"].includes(event.key)) return;
      event.preventDefault(); onResize(divider.id, event.key === "Home" ? .15 : event.key === "End" ? .85 : divider.ratio + (event.key === backward ? -.05 : .05));
    }} />;
}

function DesktopWorkspace() {
  const [layout, dispatch] = useReducer(paneReducer, undefined, initialLayout);
  const [header, setHeader] = useState(null), [sidebar, setSidebar] = useState(null), [footer, setFooter] = useState(null), [settings, setSettings] = useState(null);
  const [settingsOwner, setSettingsOwner] = useState(null);
  const [draggedTask, setDraggedTask] = useState(null);
  const [dropPreview, setDropPreview] = useState(null);
  const clearTaskDrag = useCallback(() => { setDraggedTask(null); setDropPreview(null); }, []);
  useEffect(() => {
    window.addEventListener('dragend', clearTaskDrag);
    window.addEventListener('drop', clearTaskDrag);
    window.addEventListener('blur', clearTaskDrag);
    return () => {
      window.removeEventListener('dragend', clearTaskDrag);
      window.removeEventListener('drop', clearTaskDrag);
      window.removeEventListener('blur', clearTaskDrag);
    };
  }, [clearTaskDrag]);
  const [paneViews, setPaneViews] = useState({ 'pane-1': 'board' });
  const onViewChange = useCallback((id, view) => setPaneViews(current => current[id] === view ? current : { ...current, [id]: view }), []);
  const boardActive = paneViews[layout.active] === 'board';
  const [sidebarState, setSidebarState] = useState(() => readSidebar(window.localStorage));
  const sidebarHidden = boardActive || sidebarState.collapsed;
  const [viewport, setViewport] = useState(window.innerWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const width = sidebarWidth(sidebarState.width, viewport);
  const toggleSidebar = useCallback(() => setSidebarState(value => ({ ...value, collapsed: !value.collapsed })), []);
  const resizeSidebar = value => setSidebarState(state => ({ ...state, width: sidebarWidth(value, viewport) }));
  const hosts = useMemo(() => ({ header, sidebar, footer, settings, sidebarCollapsed: sidebarHidden, toggleSidebar }), [header, sidebar, footer, settings, sidebarHidden, toggleSidebar]);
  useEffect(() => { try { window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebarState)); } catch { /* unavailable storage */ } }, [sidebarState]);
  useEffect(() => {
    const resized = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  const canvas = useRef(null);
  const controllers = useRef(new Map());
  const counter = useRef(1);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const browserWorkspaces = useRef('');
  const register = useCallback((id, controller) => {
    if (controller) controllers.current.set(id, controller); else controllers.current.delete(id);
    const ids = [...new Set([...controllers.current.values()].map(item => item.workspaceId).filter(Boolean))].sort();
    const key = JSON.stringify(ids);
    if (browserWorkspaces.current !== key) { browserWorkspaces.current = key; window.jolo.setBrowserWorkspaces(ids); }
  }, []);
  const split = useCallback((source, axis, options = {}) => {
    if (layoutRef.current.panes.length >= MAX_PANES) return;
    const id = `pane-${++counter.current}`;
    const project = controllers.current.get(source)?.project;
    const newChat = !options.task && project?.standalone;
    dispatch({ type: "split", source, axis, id, path: newChat ? null : options.task?.rootPath ?? project?.rootPath, newChat, task: options.task, before: options.before });
    return id;
  }, []);
  const close = useCallback((id) => dispatch({ type: "close", id }), []);
  const zoom = useCallback((id) => dispatch({ type: "zoom", id }), []);
  const resize = useCallback((id, ratio) => dispatch({ type: "resize", id, ratio }), []);
  // Browser guests are expensive; retain the existing one-live-browser policy across splits.
  const onBrowserOpen = useCallback((id) => { for (const [other, controller] of controllers.current) if (other !== id) controller.closeBrowser(); }, []);
  useEffect(() => window.jolo.onBrowserOpen(({ workspaceId, expiresAt }) => {
    if (Date.now() >= expiresAt) throw new Error('browser open request expired');
    if (document.querySelector('dialog[open], .settings-page')) throw new Error('close the host dialog before opening the browser');
    const [id, controller] = browserTarget(controllers.current, workspaceId, layoutRef.current.active);
    if (layoutRef.current.zoom && layoutRef.current.zoom !== id) dispatch({ type: 'zoom', id: layoutRef.current.zoom });
    dispatch({ type: 'focus', id });
    controller.showTask();
    controller.openBrowser();
  }), []);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b' && !document.querySelector('dialog[open], .settings-page')) {
        event.preventDefault(); if (!boardActive) toggleSidebar(); return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || (event.code !== "Backslash" && event.key !== "\\") || document.querySelector("dialog[open], .settings-page")) return;
      event.preventDefault(); split(layoutRef.current.active, event.shiftKey ? "y" : "x");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [split, toggleSidebar, boardActive]);
  useEffect(() => {
    if (!window.jolo.smoke) return;
    window.__joloSmoke = new Proxy({}, { get: (_target, property) => {
      if (property === "panes") return () => layoutRef.current.panes.map(({ id }) => ({ id, ...controllers.current.get(id)?.state() }));
      if (property === "split") return (axis = "x") => split(layoutRef.current.active, axis);
      if (property === "focusPane") return (id) => dispatch({ type: "focus", id });
      if (property === "closePane") return close;
      if (property === "zoomPane") return zoom;
      if (property === "layout") return () => layoutRef.current;
      return controllers.current.get(layoutRef.current.active)?.[property];
    } });
    return () => { delete window.__joloSmoke; };
  }, [split, close, zoom]);

  const geometry = paneRects(layout.tree);
  const acceptsTaskDrop = event => draggedTask && !settingsOwner && layout.panes.length < MAX_PANES &&
    !document.querySelector('dialog[open]') && Array.from(event.dataTransfer.types).includes(TASK_DRAG_TYPE);
  return <TaskDragContext.Provider value={setDraggedTask}><div className={`app split-app${sidebarHidden ? ' sidebar-collapsed' : ''}${sidebarDragging ? ' sidebar-resizing' : ''}`} data-platform={window.jolo.platform}
    style={/** @type {import('react').CSSProperties} */ ({ '--sidebar-width': `${sidebarHidden ? 0 : width}px`, '--sidebar-expanded-width': `${width}px`, '--header-sidebar-width': sidebarHidden ? 'max-content' : `${width}px` })}>
    <div className="shell-slot" ref={setHeader} />
    <div className={`workspace-body${settingsOwner ? ' settings-open' : ''}`}>
      <div className="workspace-sidebar" id="workspace-sidebar" ref={setSidebar} inert={Boolean(settingsOwner) || sidebarHidden} aria-hidden={sidebarHidden || undefined} />
      {!settingsOwner && !sidebarHidden && <SidebarDivider width={width} maximum={sidebarLimit(viewport)} onResize={resizeSidebar} onDragging={setSidebarDragging} />}
      <div className="pane-canvas" ref={canvas} data-pane-count={layout.panes.length} inert={Boolean(settingsOwner)}>
        {layout.panes.map((pane) => {
          const hidden = Boolean(layout.zoom && layout.zoom !== pane.id);
          const rect = layout.zoom === pane.id ? { x: 0, y: 0, width: 100, height: 100 } : geometry.panes[pane.id];
          return <section key={pane.id} className={`pane-slot${layout.active === pane.id ? " focused" : ""}${layout.panes.length > 1 ? " compact-pane" : ""}`} data-pane-id={pane.id} aria-label={`Workspace pane ${pane.id.slice(5)}`} hidden={hidden}
            style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
            onPointerDownCapture={() => dispatch({ type: "focus", id: pane.id })} onFocusCapture={() => dispatch({ type: "focus", id: pane.id })}>
            <WorkspacePane pane={pane} active={layout.active === pane.id} visible={!hidden && !settingsOwner} multi={layout.panes.length > 1} zoomed={layout.zoom === pane.id} canSplit={layout.panes.length < MAX_PANES} hosts={hosts} settingsOpen={settingsOwner === pane.id} onSettingsChange={setSettingsOwner} onViewChange={onViewChange} onActivate={() => dispatch({ type: "focus", id: pane.id })} onSplit={split} onClose={close} onZoom={zoom} register={register} onBrowserOpen={onBrowserOpen} />
            {draggedTask && !hidden && !settingsOwner && <div className="task-split-target"
              onDragOver={event => {
                if (!acceptsTaskDrop(event)) return;
                event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
                const side = taskDropSide(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
                setDropPreview(current => current?.id === pane.id && current.side === side ? current : { id: pane.id, side });
              }}
              onDragLeave={event => { if (!event.currentTarget.contains(/** @type {Node} */ (event.relatedTarget))) setDropPreview(null); }}
              onDrop={event => {
                if (!acceptsTaskDrop(event)) return;
                event.preventDefault(); event.stopPropagation();
                const side = taskDropSide(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
                split(pane.id, side === 'top' || side === 'bottom' ? 'y' : 'x', { task: draggedTask, before: side === 'left' || side === 'top' });
                clearTaskDrag();
              }}>
              {layout.panes.length >= MAX_PANES ? <span className="task-split-hint">Close a pane to open another split</span> : dropPreview?.id === pane.id ?
                <div className={`task-split-preview ${dropPreview.side}`}><span>Open task {({ top: 'above', bottom: 'below', left: 'on the left', right: 'on the right' })[dropPreview.side]}</span></div> :
                <span className="task-split-hint">Drop a task here to split</span>}
            </div>}
          </section>;
        })}
        {!layout.zoom && geometry.dividers.map((divider) => <Divider key={divider.id} divider={divider} canvas={canvas} onResize={resize} />)}
      </div>
      <div className="workspace-settings" ref={setSettings} hidden={!settingsOwner} />
    </div>
    <div className="shell-slot" ref={setFooter} />
    <Notices />
  </div></TaskDragContext.Provider>;
}

export function App() { return <EngineProvider><DesktopWorkspace /></EngineProvider>; }
