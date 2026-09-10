// Which models a hosted agent can run, asked of the agent itself.
//
// Jolo keeps no list of anyone's models: they change without notice, and a stale list is worse than none.
// Each transport is asked over its own protocol instead — Claude answers its initialize, Codex has
// model/list, an ACP agent publishes a model selector — so what the user picks from is what that install
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

/** One model as Jolo offers it, whatever the vendor called its fields. */
const model = ({ id, displayName, description, isDefault = false, efforts: levels = [] }) => ({
  id, displayName: text(displayName, id), description: text(description), isDefault: Boolean(isDefault), efforts: efforts(levels).slice(0, 20),
});

/**
 * @param {{ catalog: any, supervisor: any, build?: string, log: any }} deps
 */
export function createModelDirectory({ catalog, supervisor, build = "dev", log }) {
  const answered = new Map(); // agentId -> recent successful answer
  const pending = new Map(); // concurrent clients share one probe per agent

  /** Start the agent, ask it, and stop it. `open` speaks first; `ask` returns the answer once it has one. */
  const probe = async (manifest, argv, { open, ask }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let link;
    try {
      link = spawnLineChild({ argv, cwd: tmpdir(), env: hostedEnvironment(supervisor), signal: controller.signal, log, agentId: manifest.id });
    } catch (error) {
      clearTimeout(timer);
      return { models: [], note: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
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
    const { exitCode, stderr } = await link.settle();
    if (answer) return answer;
    if (controller.signal.aborted) return { models: [], note: `${manifest.displayName} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds; type the model name it expects` };
    return { models: [], note: failure ?? `${manifest.displayName} exited ${exitCode ?? "?"} without a model list${stderr ? `: ${stderr.slice(0, 200)}` : ""}` };
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
            efforts: entry.supportsEffort ? entry.supportedEffortLevels : [],
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
      if (selector) return { models: selector.options.map((option) => model({ id: option.value, displayName: option.name, description: option.description, isDefault: option.value === selector.current })), efforts: levels, note: null };
      const vendor = message.result?.models;
      if (Array.isArray(vendor?.availableModels)) {
        return {
          models: vendor.availableModels.filter((entry) => text(entry?.modelId)).map((entry) => model({
            id: entry.modelId, displayName: entry.name, description: entry.description,
            isDefault: entry.modelId === vendor.currentModelId, efforts: entry._meta?.reasoningEfforts,
          })),
          efforts: levels,
          note: null,
        };
      }
      return { models: [], efforts: levels, note: `${manifest.displayName} does not publish a model list; type the model name it expects` };
    },
  });

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
