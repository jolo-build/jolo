// The set of third-party agents this engine can launch.
// Built-in manifests ship with Jolo; a user may add or replace one by dropping JSON into the agents
// directory. Every manifest is validated before it is offered, and a malformed file is skipped with a
// warning rather than taking the whole catalog down with it.
//
// A manifest also says how its CLI is told which model to run. The choice itself is the user's, kept in
// settings under the agent's id, so it survives a manifest change and is one place to look.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AgentManifestSchema, ProtocolError } from "@jolo/protocol";
import { BUILTIN_MANIFESTS, TRANSPORT_MODEL_SUPPORT } from "./manifests.js";
import { compileRules } from "./status.js";

const MANIFEST_MAX_BYTES = 64 * 1024;
const NO_CONFIG = Object.freeze({ model: null, effort: null });

function resolveBinary(name, toolPath) {
  if (!name) return null;
  if (name.includes("/")) { try { return statSync(name).isFile() ? name : null; } catch { return null; } }
  for (const dir of toolPath.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

/** Whether Jolo can set a model (or effort) for this manifest at all, and by which route. */
export function modelSupport(manifest) {
  const support = TRANSPORT_MODEL_SUPPORT[manifest.transport] ?? TRANSPORT_MODEL_SUPPORT.pty;
  return {
    model: support.model === "flag" ? (manifest.modelArgs?.length ? "flag" : "none") : support.model,
    effort: support.effort === "flag" ? (manifest.effortArgs?.length ? "flag" : "none") : support.effort,
  };
}

const fill = (template, token, value) => template.map((part) => part.replaceAll(token, value));

/**
 * @param {{ dir: string, env: { path: string }, shell: string | null, settings?: { agent: (id: string) => { model: string | null, effort: string | null } }, log: any }} options
 */
export function createCatalog({ dir, env, shell, settings = null, log }) {
  const manifests = new Map();
  const load = (raw, source, origin) => {
    const parsed = AgentManifestSchema.safeParse(raw);
    if (!parsed.success) {
      log?.warn("agent manifest ignored", { origin, issues: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
      return;
    }
    manifests.set(parsed.data.id, { ...parsed.data, source, compiled: compileRules(parsed.data.rules, log) });
  };
  for (const manifest of BUILTIN_MANIFESTS) load(manifest, "builtin", `builtin:${manifest.id}`);
  let userFiles = [];
  try { userFiles = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch { /* no user catalog */ }
  for (const name of userFiles) {
    const file = path.join(dir, name);
    try {
      if (statSync(file).size > MANIFEST_MAX_BYTES) { log?.warn("agent manifest ignored: too large", { file }); continue; }
      load(JSON.parse(readFileSync(file, "utf8")), "user", file);
    } catch (error) {
      log?.warn("agent manifest ignored: unreadable", { file, error: String(error?.message ?? error) });
    }
  }

  /** The shell agent has no fixed binary; it launches whatever this user's shell is. */
  const binaryFor = (manifest) => (manifest.id === "shell" ? shell ?? "/bin/sh" : manifest.binary);
  /** What this agent was configured to run with, ignoring anything its transport cannot carry. */
  // An override belongs to one run and never touches what the agent is configured with (§6.6): a named value
  // wins, an explicit null means "no option at all" (how models are probed), and undefined keeps the setting.
  const configFor = (manifest, { model, effort } = {}) => {
    const chosen = settings?.agent(manifest.id) ?? NO_CONFIG;
    const support = modelSupport(manifest);
    const wantedModel = model === undefined ? chosen.model ?? null : model;
    const wantedEffort = effort === undefined ? chosen.effort ?? null : effort;
    return { model: support.model === "none" ? null : wantedModel, effort: support.effort === "none" ? null : wantedEffort, support };
  };

  return {
    /** What clients may offer, including whether the binary is actually installed and what it will run. */
    list() {
      return [...manifests.values()].map((manifest) => {
        const binary = binaryFor(manifest);
        const resolvedPath = resolveBinary(binary, env.path);
        const { model, effort, support } = configFor(manifest);
        return {
          id: manifest.id, displayName: manifest.displayName, description: manifest.description, binary,
          statusModel: manifest.statusModel, transport: manifest.transport,
          available: Boolean(resolvedPath), resolvedPath, source: manifest.source,
          model, effort, supportsModel: support.model !== "none", supportsEffort: support.effort !== "none",
        };
      });
    },
    get(id) {
      const manifest = manifests.get(id);
      if (!manifest) throw new ProtocolError("not_found", `no manifest for agent ${id}`);
      return manifest;
    },
    config: configFor,
    /**
     * The argv to spawn. Model and effort options come first, because most of these CLIs want their own
     * options before a subcommand; the manifest's own args follow, then the opening prompt if there is one.
     * A transport that carries the model itself (Codex) contributes no flags here.
     */
    command(manifest, { prompt = null, model, effort } = {}) {
      const binary = binaryFor(manifest);
      const resolved = resolveBinary(binary, env.path);
      if (!resolved) throw new ProtocolError("unavailable", `${manifest.displayName} is not installed: ${binary} was not found on the engine's PATH`);
      const chosen = configFor(manifest, { model, effort });
      const args = [];
      if (chosen.model && chosen.support.model === "flag") args.push(...fill(manifest.modelArgs, "{model}", chosen.model));
      if (chosen.effort && chosen.support.effort === "flag") args.push(...fill(manifest.effortArgs, "{effort}", chosen.effort));
      args.push(...manifest.args);
      if (prompt && manifest.promptArgs) args.push(...fill(manifest.promptArgs, "{prompt}", prompt));
      return [resolved, ...args];
    },
  };
}
