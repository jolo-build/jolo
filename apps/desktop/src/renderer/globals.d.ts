// Globals the renderer is handed rather than imports: the preload bridge and the handles the smoke
// checks drive the window through. They are declared here because only a declaration file can widen
// `Window`; nothing in this file emits, so the bundle is unchanged.
import {} from "./session-history.js";

declare global {
  /**
   * The narrow bridge `apps/desktop/src/preload/index.cjs` exposes. Engine replies and relayed events
   * cross it as decoded JSON: the protocol validates their shape at the engine boundary, so they stay
   * untyped here rather than being restated in a second, drifting place.
   */
  interface JoloBridge {
    /** `process.platform` of the main process; the renderer has no Node of its own to ask. */
    platform: string;
    homeDirectory: () => Promise<string | null>;
    /** Absent until the user restarts into a main process that advertises the desktop API. */
    prepareVisualization?: (params: { sessionId: string, path: string }) => Promise<{ ok: boolean, result?: any, error?: string }>;
    releaseVisualization: (url: string) => void;
    call: (method: string, params?: any) => Promise<{ ok: boolean, result?: any, error?: { code: string, message: string } }>;
    /** Every subscription returns the function that ends it, so effects can return it directly. */
    onEvents: (listener: (items: any[], meta?: { resyncRequired?: boolean, previewsDropped?: boolean, terminalDropped?: boolean }) => void) => () => void;
    onEngine: (listener: (state: any) => void) => () => void;
    onFocusRequest: (listener: (payload: any) => void) => () => void;
    onNotice: (listener: (payload: any) => void) => () => void;
    onBrowserOpen: (listener: (payload: { invocationId: string, workspaceId: string, expiresAt: number }) => unknown) => () => void;
    setBrowserWorkspaces: (workspaceIds: string[]) => void;
    openFolder: () => Promise<string | null>;
    answererMenu: (options: { items: { id: string, label: string, checked?: boolean, enabled?: boolean }[] }) => Promise<string | null>;
    taskMenu: (options: { archived?: boolean, worktree?: boolean }) => Promise<string | null>;
    openChatFile?: (params: { sessionId: string, path: string }) => Promise<{ ok: boolean, error?: string }>;
    previewChatFile?: (params: { sessionId: string, path: string }) => Promise<{ ok: boolean, result?: any, error?: string }>;
    releaseChatFile?: (url: string) => Promise<unknown>;
    saveImage?: (params: { artifactId: string, name: string }) => Promise<{ ok: boolean, result?: { canceled: boolean }, error?: string }>;
    openExternal: (url: string) => Promise<boolean>;
    /** Absent for the same reason as `prepareVisualization`; a source checkout reports `managed: false`. */
    checkForUpdate?: (options?: { force?: boolean }) => Promise<JoloUpdateState>;
    resync: () => Promise<{ cursor: number }>;
    setOverlay: (active: boolean) => void;
    smoke: boolean;
  }

  /** What the release check reports. Everything but `managed` is missing when the check failed. */
  interface JoloUpdateState {
    managed?: boolean;
    current?: string;
    latest?: string;
    available?: boolean;
    releaseUrl?: string;
    error?: string;
  }

  /** One terminal view, published so the smoke checks can type into the shell the user sees. */
  interface JoloTerminalHook {
    readonly ready: boolean;
    fontFamily: () => string;
    input: (data: string) => Promise<any>;
    text: () => string;
  }

  interface Window {
    jolo: JoloBridge;
    /**
     * A proxy the smoke checks call pane controls through. Its properties are whatever the pane
     * registered, so there is no fixed shape to state, and it exists only while the workspace is up.
     */
    __joloSmoke?: any;
    __joloTerminals?: Map<string, JoloTerminalHook>;
    __joloTerminal?: JoloTerminalHook;
  }
}

// `SessionHistory` takes its collaborators through `Object.assign(this, …)`, which declares no
// properties for the checker. Naming them here keeps the constructor a single assignment.
declare module "./session-history.js" {
  interface SessionHistory {
    sessionId: string;
    projection: import("@jolo/client/projection").SessionProjection;
    call: (method: string, params?: any) => Promise<any>;
    onChange: () => void;
    isCurrent: () => boolean;
  }
}
