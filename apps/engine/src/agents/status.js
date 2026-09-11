// What is this agent doing?
// Pure: the caller supplies the screen, the title, and the process facts. Every answer names the signal
// it came from, so a client can say "waiting for you" without implying Jolo knows that for certain.

const REGION_MAX_CHARS = 8 * 1024;

/** Compile a manifest's rules once. An unusable pattern is dropped rather than failing the whole agent. */
/**
 * @param {readonly any[]} [rules] a manifest's rules, or the frozen generic set
 * @param {any} [log]
 */
export function compileRules(rules = [], log = null) {
  const compiled = [];
  for (const rule of rules) {
    if (rule.regex) {
      try { compiled.push({ ...rule, matcher: new RegExp(rule.regex, "m") }); }
      catch (error) { log?.warn("agent rule ignored: invalid pattern", { rule: rule.id, error: String(error?.message ?? error) }); }
    } else if (rule.contains) {
      const needle = rule.contains.toLowerCase();
      compiled.push({ ...rule, matcher: { test: (text) => text.toLowerCase().includes(needle) } });
    }
  }
  return compiled.sort((a, b) => b.priority - a.priority);
}

/** The slice of the screen a rule looks at. Bounded, because a rule must never scan the whole scrollback. */
export function region(rule, { screen = "", title = "" }) {
  if (rule.region === "title") return title.slice(0, REGION_MAX_CHARS);
  const lines = screen.split("\n").filter((line) => line.trim() !== "");
  const count = rule.region === "screen" ? 60 : rule.regionLines;
  return lines.slice(-count).join("\n").slice(-REGION_MAX_CHARS);
}

/**
 * @param {{ rules?: any[], statusModel?: string, idleMs?: number, screen?: string, title?: string,
 *           exited?: boolean, exitCode?: number | null, msSinceOutput?: number, started?: boolean }} input
 * @returns {{ status: string, source: string, detail: string | null }}
 */
export function detectStatus(input) {
  const { rules = [], statusModel = "process", idleMs = 4_000, exited = false, exitCode = null, msSinceOutput = 0, started = true } = input;
  // Liveness is the only thing Jolo knows rather than infers, so it outranks every rule.
  if (exited) return { status: "done", source: "process", detail: exitCode === 0 || exitCode === null ? null : `exit ${exitCode}` };
  if (!started) return { status: "starting", source: "process", detail: null };
  if (statusModel === "screen") {
    for (const rule of rules) {
      if (rule.matcher.test(region(rule, input))) return { status: rule.state, source: "screen", detail: rule.id };
    }
  }
  // No rule spoke. A quiet agent is waiting for someone; a noisy one is busy.
  return msSinceOutput >= idleMs
    ? { status: "idle", source: "silence", detail: null }
    : { status: "working", source: "silence", detail: null };
}
