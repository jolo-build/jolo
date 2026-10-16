// How much of a hosted agent's plan is left, asked of the agent itself.
//
// Claude Code, Codex and Antigravity all know the signed-in account's usage windows (a five-hour window, a weekly
// one, sometimes one per model or model group) and answer without spending a model request: Claude through its
// get_usage control request, Codex through account/rateLimits/read, Antigravity through its /usage command. Jolo only reshapes the answer into windows the
// composer's usage panel can show side by side. An answer about the account is kept briefly, since opening the
// panel again a moment later should not start the agent again; a passing failure is asked again next time.
import { claudeArgv } from "./claude-stream.js";
import { probeAgent } from "./models.js";
import { LIMIT_REPORTING } from "./manifests.js";

const CACHE_TTL_MS = 60_000;
// Only agent.limits waits on these probes, and clients give it 65 s (packages/client). Antigravity's /usage signs in
// to Google first and took 5 to 8 s, once 16 s, so a limits probe gets longer than a model probe.
const PROBE_TIMEOUT_MS = 15_000;
const MAX_WINDOWS = 20;
// What agent.limits may carry (packages/protocol/src/schemas.js): a longer vendor name is cut, never a failed call.
const MAX_LABEL = 120;
const MAX_PLAN = 80;
const MAX_NOTE = 300;

/**
 * @typedef {{ label: string, usedPercent: number, resetsAt: string | null }} LimitWindow
 * @typedef {{ agentId: string, windows: LimitWindow[], plan: string | null, source: "agent" | "none", note: string | null, checkedAt: string }} LimitReport
 * An agent's answer before it is reported. `source` says it describes the account: windows ("agent") or a
 * settled absence of them ("none"). Without one it is a passing failure, such as a refusal or an error, and
 * the next request asks again.
 * @typedef {{ windows: LimitWindow[], plan: string | null, source?: "agent" | "none", note: string | null }} LimitAnswer
 */

const text = (value) => (typeof value === "string" && value ? value : null);
const percent = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null);

/** An ISO timestamp from an ISO string or Unix seconds; null when the agent gave neither. */
function instant(value) {
  const date = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** "5-hour", "Weekly", "3-day": what a window of this many minutes is called. */
function durationLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return "Usage";
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** One of Claude's declared windows, `{ utilization: 0-100, resets_at }`, or null when it is not in force. */
const claudeWindow = (label, window) => (percent(window?.utilization) === null ? null : { label, usedPercent: percent(window.utilization), resetsAt: instant(window.resets_at) });

/**
 * Claude's get_usage answer as windows, read from the fields its schema declares: the five-hour and weekly
 * windows, the older per-family weekly ones, and the per-model weekly ones. These are present whether Claude
 * fetched them just now or answered from its cached snapshot while the usage endpoint was failing; with
 * neither, it has nothing to show yet, which passes.
 * @returns {LimitAnswer}
 */
export function claudeWindows(usage) {
  const plan = text(usage?.subscription_type);
  if (usage?.rate_limits_available !== true) return { windows: [], plan, source: "none", note: "Claude Code reports no plan limits for this sign-in" };
  const limits = usage.rate_limits;
  if (!limits || typeof limits !== "object") return { windows: [], plan, note: "Claude Code could not fetch its usage limits right now" };
  const windows = [
    claudeWindow("5-hour", limits.five_hour),
    claudeWindow("Weekly", limits.seven_day),
    claudeWindow("Weekly · Opus", limits.seven_day_opus),
    claudeWindow("Weekly · Sonnet", limits.seven_day_sonnet),
    ...(Array.isArray(limits.model_scoped) ? limits.model_scoped : []).map((entry) => claudeWindow(`Weekly · ${text(entry?.display_name) ?? "model"}`, entry)),
  ].filter(Boolean);
  return { windows: windows.slice(0, MAX_WINDOWS), plan, source: windows.length ? "agent" : "none", note: windows.length ? null : "Claude Code listed no limits" };
}

/**
 * Codex's account/rateLimits/read answer as windows. Each limit bucket has a primary and an optional
 * secondary window, sized in minutes; a named bucket is labelled with its name. The per-limit buckets are
 * read when Codex lists any, its single backward-compatible bucket otherwise.
 * @returns {LimitAnswer}
 */
export function codexWindows(result) {
  const listed = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object" ? Object.values(result.rateLimitsByLimitId) : [];
  const buckets = listed.length ? listed : result?.rateLimits ? [result.rateLimits] : [];
  const windows = buckets.flatMap((bucket) => [bucket?.primary, bucket?.secondary]
    .filter((window) => percent(window?.usedPercent) !== null)
    .map((window) => {
      const name = text(bucket.limitName);
      return { label: name ? `${durationLabel(window.windowDurationMins)} · ${name}` : durationLabel(window.windowDurationMins), usedPercent: percent(window.usedPercent), resetsAt: instant(window.resetsAt) };
    }));
  const plan = buckets.map((bucket) => text(bucket?.planType)).find(Boolean)?.replaceAll("_", " ") ?? null; // e.g. "self_serve_business_usage_based"
  return { windows: windows.slice(0, MAX_WINDOWS), plan, source: windows.length ? "agent" : "none", note: windows.length ? null : "Codex reports no usage limits for this sign-in" };
}

/** Antigravity's window lengths, as its /usage command spells them. */
const ANTIGRAVITY_WINDOWS = Object.freeze({ "5h": "5-hour", weekly: "Weekly" });

/**
 * Antigravity's /usage answer as windows. Each model group (Gemini models, the Claude and GPT models) has its own
 * five-hour and weekly bucket, and each bucket says what fraction is left; a window is labelled with its group, as
 * Codex's named buckets are.
 * @returns {LimitAnswer}
 */
export function antigravityWindows(usage) {
  const groups = Array.isArray(usage?.groups) ? usage.groups : [];
  const windows = groups.flatMap((group) => (Array.isArray(group?.buckets) ? group.buckets : [])
    .filter((bucket) => percent(bucket?.remaining_fraction) !== null)
    .map((bucket) => {
      const length = ANTIGRAVITY_WINDOWS[bucket.window] ?? text(bucket.name) ?? "Usage";
      const name = text(group.name)?.replace(/\s+models$/i, ""); // "Gemini Models" reads as "Gemini" in a narrow row
      return { label: name ? `${length} · ${name}` : length, usedPercent: Math.max(0, (1 - bucket.remaining_fraction) * 100), resetsAt: instant(bucket.reset_time) };
    }));
  return { windows: windows.slice(0, MAX_WINDOWS), plan: null, source: windows.length ? "agent" : "none", note: windows.length ? null : "Antigravity CLI reports no usage limits for this sign-in" };
}

/**
 * @param {{ catalog: any, supervisor: any, build: string, log: any }} deps
 */
export function createLimitDirectory({ catalog, supervisor, build, log }) {
  const answered = new Map(); // agentId -> recent successful answer
  const pending = new Map(); // concurrent clients share one probe per agent

  /** Claude answers get_usage on the same structured stream a turn uses; skip_behaviors leaves out its transcript scan. */
  const fromClaude = (manifest) => {
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null });
    return probeAgent({ supervisor, log }, manifest, claudeArgv(binary, extraArgs), PROBE_TIMEOUT_MS, {
      open: (send) => send({ type: "control_request", request_id: "jolo-limits", request: { subtype: "get_usage", skip_behaviors: true } }),
      ask: (message) => {
        if (message.type !== "control_response" || message.response?.request_id !== "jolo-limits") return null; // it may greet first
        if (message.response.subtype === "error") return { windows: [], plan: null, note: text(message.response.error) ?? "Claude Code refused the request" };
        return claudeWindows(message.response.response);
      },
    });
  };

  /** Codex reads the account's rate limits from its app-server after the usual handshake. */
  const fromCodex = (manifest) => {
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null });
    return probeAgent({ supervisor, log }, manifest, [binary, ...extraArgs, "app-server"], PROBE_TIMEOUT_MS, {
      open: (send) => send({ id: 1, method: "initialize", params: { clientInfo: { name: "jolo", title: "Jolo", version: build }, capabilities: { experimentalApi: false } } }),
      ask: (message, send) => {
        if (message.id === 1) {
          if (message.error) return { windows: [], plan: null, note: text(message.error.message) ?? "Codex refused to start" };
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
          return null;
        }
        if (message.id !== 2) return null;
        if (message.error) return { windows: [], plan: null, note: text(message.error.message) ?? "Codex did not report its usage limits" };
        return codexWindows(message.result);
      },
    });
  };

  /** Antigravity answers its /usage command with one JSON result when asked for JSON output. */
  const fromAntigravity = (manifest) => {
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null });
    return probeAgent({ supervisor, log }, manifest, [binary, ...extraArgs, "--output-format", "json", "--print=/usage"], PROBE_TIMEOUT_MS, {
      open: () => {},
      ask: (message) => {
        if (message.status && message.status !== "SUCCESS") return { windows: [], plan: null, note: text(message.error) ?? "Antigravity CLI could not read its usage limits" };
        return message.command?.name === "usage" ? antigravityWindows(message.command.data) : null;
      },
    });
  };
  const readers = { "claude-stream": fromClaude, "codex-app-server": fromCodex, "antigravity-stream": fromAntigravity };

  return {
    /** Ask one agent how much of its plan is used. Never throws for a vendor's own failure: that becomes the note. */
    async read(agentId, { refresh }) {
      const manifest = catalog.get(agentId); // an unknown id is the caller's mistake, and stays an error
      if (!LIMIT_REPORTING.has(manifest.transport)) {
        return { agentId, windows: [], plan: null, source: "none", note: `${manifest.displayName} does not report usage limits`, checkedAt: new Date().toISOString() };
      }
      if (pending.has(agentId)) return pending.get(agentId);
      const remembered = answered.get(agentId);
      if (!refresh && remembered && Date.now() < remembered.expiresAt) return remembered.answer;
      const request = (async () => {
        const result = await readers[manifest.transport](manifest);
        /** @type {LimitReport} */
        const answer = {
          agentId,
          windows: (result.windows ?? []).map((window) => ({ ...window, label: window.label.slice(0, MAX_LABEL) })),
          plan: result.plan ? result.plan.slice(0, MAX_PLAN) : null,
          source: result.source ?? "none",
          note: result.note ? String(result.note).slice(0, MAX_NOTE) : null,
          checkedAt: new Date().toISOString(),
        };
        // An answer about the account is kept, "no limits for this sign-in" included, since the composer asks on
        // every task switch. A refusal, an error, or a probe that never got an answer is asked again next time.
        if (result.source !== undefined) answered.set(agentId, { answer, expiresAt: Date.now() + CACHE_TTL_MS });
        else answered.delete(agentId);
        return answer;
      })();
      pending.set(agentId, request);
      try { return await request; }
      finally { pending.delete(agentId); }
    },
  };
}
