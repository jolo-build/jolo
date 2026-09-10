// Built-in manifests for third-party coding-agent CLIs.
// A manifest is data, never code: it names a binary, how to launch it, and how to guess what it is doing.
//
// Jolo does not drive these agents and cannot see inside them. Status comes from the child process's
// liveness (authoritative) and from patterns matched against the terminal screen (a guess). The rules
// below are deliberately generic terminal-UI heuristics rather than claims about any vendor's exact
// wording, because that wording changes without notice. Override them per agent in the user catalog.

const NEEDS_INPUT = [
  { id: "yes-no-prompt", state: "needs_input", priority: 1000, region: "bottom", regionLines: 6, regex: "\\((?:y\\/n|Y\\/n|y\\/N)\\)|\\[(?:y\\/N|Y\\/n)\\]" },
  { id: "asks-to-proceed", state: "needs_input", priority: 990, region: "bottom", regionLines: 8, regex: "(?:Do you want|Would you like|Allow this|Approve this|Proceed\\?)" },
  { id: "numbered-choice", state: "needs_input", priority: 980, region: "bottom", regionLines: 8, regex: "(?:^|\\s)(?:❯|>)\\s*1[.)]\\s" },
  { id: "press-enter", state: "needs_input", priority: 970, region: "bottom", regionLines: 4, regex: "[Pp]ress (?:enter|Enter|return)" },
];

const WORKING = [
  { id: "interrupt-hint", state: "working", priority: 900, region: "bottom", regionLines: 6, regex: "esc to interrupt|ctrl\\+c to (?:stop|cancel)" },
  { id: "spinner", state: "working", priority: 890, region: "bottom", regionLines: 4, regex: "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]" },
  { id: "progress-word", state: "working", priority: 880, region: "bottom", regionLines: 4, regex: "(?:Thinking|Working|Generating|Running|Analyzing)(?:…|\\.\\.\\.)" },
];

/** The shared heuristics. A vendor-specific manifest may replace them entirely. */
export const GENERIC_RULES = Object.freeze([...NEEDS_INPUT, ...WORKING]);

const hostedAgent = (id, displayName, binary, description, transport, args = [], flags = {}) => ({ id, displayName, binary, description, args, transport, statusModel: "process", idleMs: 4_000, rules: [], ...flags });

/** How each transport can be told which model to run. "flag" needs the manifest to spell the option;
 *  "protocol" is carried by the adapter itself; "none" means Jolo leaves the choice to the agent. */
export const TRANSPORT_MODEL_SUPPORT = Object.freeze({
  pty: Object.freeze({ model: "none", effort: "none" }),
  "claude-stream": Object.freeze({ model: "flag", effort: "flag" }),
  "codex-app-server": Object.freeze({ model: "protocol", effort: "protocol" }),
  acp: Object.freeze({ model: "flag", effort: "flag" }),
});

export const BUILTIN_MANIFESTS = Object.freeze([
  // These speak a structured protocol: replies, tool calls and permission questions arrive as data, so they answer
  // as a Jolo session rather than in a watched terminal. Protocol flags are the adapter's; a manifest's args are
  // the vendor's own options (Claude: e.g. --model; Codex: -c key=value; ACP agents: whatever starts their agent mode).
  hostedAgent("claude", "Claude Code", "claude", "Anthropic's coding agent CLI, driven through its structured stream.", "claude-stream", [], { modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }),
  hostedAgent("codex", "Codex", "codex", "OpenAI's coding agent CLI, driven through its app-server.", "codex-app-server"),
  hostedAgent("grok", "Grok CLI", "grok", "xAI's coding agent CLI, driven through the Agent Client Protocol.", "acp", ["--permission-mode", "default", "agent", "stdio"], { modelArgs: ["-m", "{model}"], effortArgs: ["--reasoning-effort", "{effort}"] }),
  hostedAgent("gemini", "Gemini CLI", "gemini", "Google's coding agent CLI, driven through the Agent Client Protocol.", "acp", ["--acp"], { modelArgs: ["-m", "{model}"] }),
  {
    id: "shell",
    displayName: "Login shell",
    binary: "sh", // the catalog substitutes this user's own shell at launch
    description: "A plain interactive shell, for an agent Jolo has no manifest for.",
    args: [],
    statusModel: "process",
    idleMs: 4_000,
    rules: [],
  },
]);
