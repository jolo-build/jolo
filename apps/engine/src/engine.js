import { TaskService } from './account/tasks.js';
import { createExecutorRouter } from "./agents/executor.js";
import { createRpcHandlers } from "./rpc/handlers.js";
// Engine composition: ownership, storage, run service, endpoint, RPC server, lifetime.
import path from 'node:path';
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "@jolo/protocol";
import { Storage, newId } from "./storage/index.js";
import { RunService } from "./runs/service.js";
import { createAgentExecutor } from "./agent/loop.js";
import { SettingsService } from "./settings.js";
import { CredentialService } from "./credentials/index.js";
import { AccountService } from './account/service.js';
import { PermissionService } from "./permissions/service.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolDispatcher, resolveToolEnvironment } from "./tools/dispatcher.js";
import { createProviderCatalog } from './providers/presets.js';
import { ProviderFactory } from "./providers/index.js";
import { BrowserBroker } from "./browser/broker.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { TerminalService } from "./terminal/service.js";
import { createBoard } from "./board/index.js";
import { createWorktreeService } from "./workspaces/worktrees.js";
import { createOrchestrator } from "./orchestrator/index.js";
import { SELF_MENTION } from "./agents/mentions.js";
import { createCatalog } from "./agents/catalog.js";
import { createModelDirectory } from "./agents/models.js";
import { AgentService } from "./agents/service.js";
import { CapabilityTokens } from "./rpc/capabilities.js";
import { createRpcServer } from "./rpc/server.js";
import { prepareEndpoint } from "./endpoint.js";
import { createLifetime } from "./lifetime.js";
import { createLogger } from "./log.js";
import { TgrepService } from "./search/tgrep.js";
import { searchMcpConfig } from "./search/hosted.js";
import { createBrowserConfig } from './browser/hosted.js';

export { OwnershipError, SchemaError } from "./storage/index.js";


/**
 * @param {{ paths: any, build?: string, idleMs?: number, migrationsDir?: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: any }} options
 */
export function createEngine(options) {
  const { paths } = options;
  const build = options.build ?? "dev";
  const bootId = newId("boot");
  const capabilityTokens = new CapabilityTokens(path.join(paths.runtimeDir, "capabilities", bootId));
  const log = options.log ?? createLogger({ logDir: paths.logDir });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let storage = null;
  let settingsService = null;
  let agentModels = null;
  let credentials = null;
  let account = null;
  let permissions = null;
  let dispatcher = null;
  let browser = null;
  let supervisor = null;
  let search = null;
  let terminals = null;
  let board = null;
  let worktrees = null;
  let plans = null;
  let agents = null;
  const agentName = () => {
    const settings = settingsService?.get();
    return settings?.model?.preset ?? settings?.provider?.name ?? (settings?.demoProviderEnabled ? "fake" : "unconfigured");
  };
  let server = null;
  let endpoint = null;
  let runs = null;
  let stopping = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });

  const lifetime = createLifetime({ idleMs: options.idleMs ?? 30_000, log, onIdle: () => { log.info("idle grace period elapsed; exiting"); void stop("idle"); } });

  async function start() {
    storage = new Storage({ databasePath: paths.databasePath, artifactsDir: paths.artifactsDir, migrationsDir: options.migrationsDir ?? null, bootId });
    storage.maintain();
    log.info("database owned", { schema: storage.schema.version, applied: storage.schema.appliedNow });
    const providerCatalog = createProviderCatalog({ dir: path.join(paths.dataDir, 'providers'), log, env: options.env ?? process.env });
    settingsService = new SettingsService(storage, { env: options.env ?? process.env, catalog: providerCatalog });
    credentials = new CredentialService({ log, env: options.env ?? process.env, catalog: providerCatalog });
    account = new AccountService({ storage, paths, lifetime, env: options.env ?? process.env, fetchImpl: options.accountFetchImpl, secrets: options.accountSecrets });
    permissions = new PermissionService({ storage });
    const registry = new ToolRegistry();
    browser = new BrowserBroker({ storage, log });
    const toolEnv = resolveToolEnvironment(options.env ?? process.env);
    search = new TgrepService({ directory: path.join(paths.dataDir, 'search', 'tgrep-v1'), env: toolEnv, log });
    supervisor = new ProcessSupervisor({ storage, log, env: toolEnv, recoveryDir: paths.recoveryDir, baseEnv: options.env ?? process.env });
    supervisor.reconcile();
    terminals = new TerminalService({ storage, supervisor, lifetime, log, shell: (options.env ?? process.env).JOLO_SHELL ?? null });
    dispatcher = new ToolDispatcher({ registry, permissions, storage, log, env: toolEnv, browser, supervisor, search, patchesDir: paths.patchesDir });
    board = createBoard({ storage, env: toolEnv, log });
    worktrees = createWorktreeService({ storage, permissions, paths, env: toolEnv, terminals, log });
    try {
      const taken = await worktrees.reconcile(); // checkouts made but never handed over, before any client can list them (§14.1)
      if (taken.removed || taken.parked) log.info("reconciled worktrees from a previous boot", taken);
    } catch (error) { log.warn("could not reconcile worktrees from a previous boot", { error: String(error) }); }
    const providerFactory = new ProviderFactory({ credentials, catalog: providerCatalog, settings: settingsService, env: options.env ?? process.env, log, fetchImpl: options.fetchImpl });
    const catalog = createCatalog({ dir: paths.agentsDir, env: toolEnv, shell: (options.env ?? process.env).JOLO_SHELL ?? (options.env ?? process.env).SHELL ?? null, settings: settingsService, log });
    agentModels = createModelDirectory({ catalog, supervisor, build, log });
    agents = new AgentService({ catalog, terminals, storage, log });
    const jolo = createAgentExecutor({ storage, dispatcher, registry, providerFactory, settings: settingsService, permissions, interactiveClients: () => server?.interactiveClientCount ?? 0, log });
    const searchConfig = (workspace, run) => {
      if (toolEnv.tgrep) void search.acquire(workspace.path).then(lease => lease?.release());
      return searchMcpConfig(toolEnv.tgrep ? { ...paths, tokenPath: capabilityTokens.issue(run.id, workspace.id).tokenPath } : paths, workspace.id, Boolean(toolEnv.tgrep));
    };
    const executor = createExecutorRouter({ storage, dispatcher, catalog, permissions, supervisor, build, log,
      searchConfig, browserConfig: createBrowserConfig({ browser, paths, capabilityTokens }),
      providerFactory, settings: settingsService, native: jolo,
      interactiveClients: () => server?.interactiveClientCount ?? 0, revoke: runId => capabilityTokens.revoke(runId) });
    runs = new RunService({ storage, executor, lifetime, log, captureProvider: (session, execution) => {
      const answerer = execution?.preset ? SELF_MENTION : execution?.agentId ?? session.agentId;
      return !answerer || answerer === SELF_MENTION ? providerFactory.capture(session, execution) : null;
    }, workspaceBusy: id => worktrees.isBusy(id) });
    const interrupted = runs.reconcile();
    if (interrupted) log.warn("marked runs interrupted from a previous boot", { count: interrupted });
    // Plans are reconciled after runs, so a task whose run has just been called interrupted is seen as such.
    plans = createOrchestrator({ storage, runs, catalog, log });
    const stopped = plans.reconcile();
    if (stopped.paused) log.warn("paused plans left running by a previous boot", stopped);
    endpoint = prepareEndpoint(paths);
    const handlers = createRpcHandlers({ storage, settingsService, providerFactory, agentModels, credentials, account, tasks: new TaskService(account), permissions, dispatcher, browser, supervisor, search, terminals, board, worktrees, plans, agents, runs, paths, bootId, build, startedMs, startedAt, agentName, stop, getServer: () => server, toolEnv });
    server = createRpcServer({ token: endpoint.token, capabilityTokens, bootId, build, storage, previews: runs.previews, lifetime, log, handlers });
    await server.listen(paths.socketPath);
    endpoint.publish({ engineBootId: bootId, pid: process.pid, build, protocol: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, startedAt });
    lifetime.start();
    log.info("engine ready", { bootId, pid: process.pid, socket: paths.socketPath, provider: agentName() });
  }

  function stop(reason) {
    if (stopping) return stopping;
    stopping = (async () => {
      log.info("engine stopping", { reason });
      const step = async (name, fn) => {
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(fn),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} shutdown timed out`)), 6000); }),
          ]);
        } catch (error) { log.error("shutdown step failed", { step: name, error: String(error) }); }
        finally { clearTimeout(timer); }
      };
      try {
        lifetime.stop();
        if (account) await step('account', () => account.stop());
        if (server) await step("rpc", () => server.close());
        if (runs) await step("runs", () => runs.stopAll());
        if (search) await step("search", () => search.close());
        if (agents) await step("agents", () => agents.dispose());
        if (terminals) await step("terminals", () => terminals.stopAll());
        if (supervisor) await step("processes", () => supervisor.stopAll());
        if (endpoint) await step("endpoint", () => endpoint.cleanup(bootId));
        if (storage) {
          await step("checkpoint", () => storage.checkpoint());
          await step("storage", () => storage.close());
        }
        log.info("engine stopped", { reason });
      } finally { resolveStopped(reason); }
    })();
    return stopping;
  }

  return { bootId, start, stop, stopped, get lifetime() { return lifetime; } };
}
