// Which models a hosted agent can run, asked of the agent itself.
//
// Jolo keeps no list of anyone's models: they change without notice, and a stale list is worse than none.
// Each transport is asked over its own protocol instead — Claude answers its initialize, Codex has
// model/list, an ACP agent publishes a model selector, Antigravity has a models command — so what the user picks from is what that install
// actually offers today. Settings loads this automatically when opened; recent answers are shared
// across interactive clients so opening another pane does not start the same agent again.
import { tmpdir } from "node:os";
import { hostedEnvironment, spawnLineChild } from "./hosted.js";
import { claudeArgv } from "./claude-stream.js";
import { modelSelector } from "./acp.js";

// A client waits 10 s for any request, and this one starts a process, so the probe has to finish inside that.
// An agent slower than this is not broken; the model field simply stays free text for it.
const PROBE_TIMEOUT_MS = 8_000;
const MAX_MODELS = 100;
const CACHE_TTL_MS = 5 * 60_000;

const text = (value, fallback = "") => (typeof value === "string" && value ? value : fallback);
const efforts = (list) => [...new Set((Array.isArray(list) ? list : []).map((entry) => (typeof entry === "string" ? entry : text(entry?.reasoningEffort ?? entry?.id ?? entry?.value))).filter(Boolean))];

/**
 * Claude's levels plus "ultracode" where the model has xhigh: `--effort ultracode` runs xhigh with standing
 * Workflow orchestration, and Claude Code gates ultracode on the same xhigh capability.
 */
const claudeEfforts = (levels) => (Array.isArray(levels) && levels.includes("xhigh") ? [...levels, "ultracode"] : levels);

/** One model as Jolo offers it, whatever the vendor called its fields. */
const model = ({ id, displayName, description, isDefault = false, efforts: levels = [] }) => ({
  id, displayName: text(displayName, id), description: text(description), isDefault: Boolean(isDefault), efforts: efforts(levels).slice(0, 20),
});

/** The thinking levels Antigravity's --effort accepts, from least to most. */
const ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Antigravity lists a model once per thinking level ("gemini-4-argon-high", "Gemini 4 Argon (High)") and takes
 * the level as --effort on the base name, so the variants become one model whose efforts are those levels.
 * @param {any} listed `command.data.models` from `agy --output-format json models`
 */
export function antigravityModels(listed) {
  const grouped = new Map(); // base id -> { displayName, levels }
  for (const entry of Array.isArray(listed) ? listed : []) {
    const id = text(entry?.id);
    if (!id) continue;
    const level = ANTIGRAVITY_EFFORTS.find((effort) => id.endsWith(`-${effort}`));
    const base = level ? id.slice(0, -level.length - 1) : id;
    const known = grouped.get(base) ?? { displayName: level ? text(entry.label, base).replace(/\s*\([^)]*\)$/, "") : text(entry.label, base), levels: [] };
    if (level) known.levels.push(level);
    grouped.set(base, known);
  }
  return [...grouped].map(([id, { displayName, levels }]) => model({ id, displayName, description: "", efforts: ANTIGRAVITY_EFFORTS.filter((effort) => levels.includes(effort)) }));
}

/**
 * Start a hosted agent, ask it one thing, and stop it. `open` speaks first; `ask` returns the answer once it
 * has one. The agent's own failure never throws: it comes back as `{ note, timedOut }` for the caller to word.
 * @param {{ supervisor: any, log: any }} deps
 * @param {any} manifest
 * @param {string[]} argv
 * @param {number} timeoutMs how long the agent has to answer, inside what its caller's client waits
 * @param {{ open: (send: (message: any) => void) => void, ask: (message: any, send: (message: any) => void) => any }} steps
 */
export async function probeAgent({ supervisor, log }, manifest, argv, timeoutMs, { open, ask }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let link;
  try {
    link = spawnLineChild({ argv, cwd: tmpdir(), env: hostedEnvironment(supervisor), signal: controller.signal, log, agentId: manifest.id });
  } catch (error) {
    clearTimeout(timer);
    return { note: `could not start ${manifest.displayName}: ${error?.message ?? error}`, timedOut: false };
  }
  let answer = null;
  let failure = null;
  try {
    const send = (message) => link.write(message);
    open(send);
    for await (const message of link.messages()) {
      answer = await ask(message, send);
      if (answer) break;
    }
  } catch (error) {
    failure = String(error?.message ?? error);
  }
  clearTimeout(timer);
  link.terminate();
  if (answer) {
    void link.settle();
    return answer;
  }
  const { exitCode, stderr } = await link.settle();
  if (controller.signal.aborted) return { note: `${manifest.displayName} did not answer within ${timeoutMs / 1000} seconds`, timedOut: true };
  return { note: failure ?? `${manifest.displayName} exited ${exitCode ?? "?"} without an answer${stderr ? `: ${stderr.slice(0, 200)}` : ""}`, timedOut: false };
}

/**
 * @param {{ catalog: any, supervisor: any, build?: string, log: any }} deps
 */
export function createModelDirectory({ catalog, supervisor, build = "dev", log }) {
  const answered = new Map(); // agentId -> recent successful answer
  const pending = new Map(); // concurrent clients share one probe per agent

  /** The shared probe; an agent too slow to answer leaves the model field as free text. */
  const probe = async (manifest, argv, steps) => {
    const result = await probeAgent({ supervisor, log }, manifest, argv, PROBE_TIMEOUT_MS, steps);
    if (Array.isArray(result.models)) return result;
    return { models: [], note: result.timedOut ? `${result.note}; type the model name it expects` : result.note };
  };

  /** Claude lists its models in the reply to the same initialize the adapter sends every turn. */
  const fromClaude = (manifest) => {
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null });
    return probe(manifest, claudeArgv(binary, extraArgs), {
      open: (send) => send({ type: "control_request", request_id: "jolo-models", request: { subtype: "initialize" } }),
      ask: (message) => {
        if (message.type !== "control_response" || message.response?.request_id !== "jolo-models") return null; // it may greet first
        if (message.response.subtype === "error") return { models: [], note: text(message.response.error, "Claude Code refused the request") };
        const listed = message.response.response?.models;
        if (!Array.isArray(listed)) return { models: [], note: "Claude Code did not report a model list" };
        return {
          models: listed.filter((entry) => text(entry?.value)).map((entry) => model({
            id: entry.value,
            displayName: entry.displayName,
            description: [text(entry.description), text(entry.resolvedModel) && entry.resolvedModel !== entry.value ? `(${entry.resolvedModel})` : ""].filter(Boolean).join(" "),
            isDefault: entry.value === "default",
            efforts: entry.supportsEffort ? claudeEfforts(entry.supportedEffortLevels) : [],
          })),
          note: null,
        };
      },
    });
  };

  /** Codex has a method for it, and pages its answer. */
  const fromCodex = (manifest) => {
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null });
    const collected = [];
    return probe(manifest, [binary, ...extraArgs, "app-server"], {
      open: (send) => send({ id: 1, method: "initialize", params: { clientInfo: { name: "jolo", title: "Jolo", version: build }, capabilities: { experimentalApi: false } } }),
      ask: (message, send) => {
        if (message.id === 1) {
          if (message.error) return { models: [], note: text(message.error.message, "Codex refused to start") };
          send({ method: "initialized" });
          send({ id: 2, method: "model/list", params: {} });
          return null;
        }
        if (message.id !== 2 && message.id !== 3) return null;
        if (message.error) return { models: [], note: text(message.error.message, "Codex did not report a model list") };
        for (const entry of message.result?.data ?? []) {
          if (!text(entry?.id) || entry.hidden) continue;
          collected.push(model({ id: entry.id, displayName: entry.displayName, description: entry.description, isDefault: entry.isDefault, efforts: entry.supportedReasoningEfforts }));
        }
        const cursor = message.result?.nextCursor;
        if (cursor && collected.length < MAX_MODELS) { send({ id: 3, method: "model/list", params: { cursor } }); return null; }
        return { models: collected, note: null };
      },
    });
  };

  /**
   * An ACP agent publishes its models as a session config option. Some also answer with a vendor-shaped list
   * under `models`, which is read only when the standard selector is absent.
   */
  const fromAcp = (manifest) => probe(manifest, catalog.command(manifest, { model: null, effort: null }), {
    open: (send) => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "jolo", title: "Jolo", version: build } } }),
    ask: (message, send) => {
      if (message.id === 1) {
        if (message.error) return { models: [], note: text(message.error.message, "the agent refused to start") };
        send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: tmpdir(), mcpServers: [] } });
        return null;
      }
      if (message.id !== 2) return null;
      if (message.error) return { models: [], note: text(message.error.message, "the agent would not open a session") };
      const selector = modelSelector(message.result?.configOptions);
      const options = message.result?.configOptions;
      const thoughtLevel = (Array.isArray(options) ? options : []).find(option => option?.category === "thought_level" && option.type === "select");
      const levels = efforts(thoughtLevel?.options);
      // ACP exposes effort alongside the model selector, rather than on each model.
      // Keep that capability on the model entries consumed by the composer too.
      if (selector) return { models: selector.options.map((option) => model({ id: option.value, displayName: option.name, description: option.description, isDefault: option.value === selector.current, efforts: levels })), efforts: levels, note: null };
      const vendor = message.result?.models;
      if (Array.isArray(vendor?.availableModels)) {
        return {
          models: vendor.availableModels.filter((entry) => text(entry?.modelId)).map((entry) => model({
            id: entry.modelId, displayName: entry.name, description: entry.description,
            isDefault: entry.modelId === vendor.currentModelId, efforts: entry._meta?.reasoningEfforts ?? levels,
          })),
          efforts: levels,
          note: null,
        };
      }
      return { models: [], efforts: levels, note: `${manifest.displayName} does not publish a model list; type the model name it expects` };
    },
  });

  /** Antigravity answers `models` with one JSON result when asked for JSON output. */
  const fromAntigravity = (manifest) => {
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null });
    return probe(manifest, [binary, ...extraArgs, "--output-format", "json", "models"], {
      open: () => {},
      ask: (message) => {
        if (message.status && message.status !== "SUCCESS") return { models: [], note: `${manifest.displayName}: ${text(message.error, "did not list its models")}` };
        const listed = message.command?.data?.models;
        return Array.isArray(listed) ? { models: antigravityModels(listed), note: null } : null;
      },
    });
  };

  return {
    /** Ask one agent what it can run. Never throws for a vendor's own failure: that becomes the note. */
    async list(agentId, { refresh = false } = {}) {
      const manifest = catalog.get(agentId); // an unknown id is the caller's mistake, and stays an error
      const support = catalog.config(manifest).support;
      if (support.model === "none" && support.effort === "none") {
        const reason = manifest.transport === "pty"
          ? `${manifest.displayName} runs in a terminal, so it chooses its own model`
          : `${manifest.displayName} has no model option in its manifest; add modelArgs to set one`;
        return { agentId, models: [], efforts: [], source: "none", note: reason };
      }
      if (pending.has(agentId)) return pending.get(agentId);
      const remembered = answered.get(agentId);
      if (!refresh && remembered && Date.now() < remembered.expiresAt) return remembered.answer;
      const request = (async () => {
        let result;
        try {
          if (manifest.transport === "claude-stream") result = await fromClaude(manifest);
          else if (manifest.transport === "codex-app-server") result = await fromCodex(manifest);
          else if (manifest.transport === "acp") result = await fromAcp(manifest);
          else if (manifest.transport === "antigravity-stream") result = await fromAntigravity(manifest);
          else result = { models: [], note: `Jolo cannot ask a ${manifest.transport} agent for its models` };
        } catch (error) {
          result = { models: [], note: String(error?.message ?? error).slice(0, 300) };
        }
        const models = result.models.slice(0, MAX_MODELS);
        const levels = efforts([...models.flatMap((entry) => entry.efforts), ...(result.efforts ?? [])]);
        const answer = { agentId, models, efforts: levels, source: models.length || levels.length ? "agent" : "none", note: result.note ? result.note.slice(0, 300) : null };
        // Only a real answer is kept: a failure should be retried, since signing in or installing fixes it.
        if (answer.source === "agent") answered.set(agentId, { answer, expiresAt: Date.now() + CACHE_TTL_MS });
        else answered.delete(agentId);
        return answer;
      })();
      pending.set(agentId, request);
      try { return await request; }
      finally { pending.delete(agentId); }
    },
  };
}
