// A task's title from whoever answers it, the way Claude Code and Codex name their chats.
//
// A task this service claims keeps a blank title while its first prompt goes to the task's answerer, on the cheapest
// model it has, for a short title; clients show a blank title on a task with a run as being named. The title is written
// only while it is still blank, so a rename by the person meanwhile wins. Anything that goes wrong names the task after
// the prompt's first 80 characters instead (Storage.assignSessionTitle), as a task the service does not claim is named
// at once, and is only logged. A crash mid-naming is recovered at startup by Storage.repairUntitledSessions.
import { collectSummary } from "./providers/retry.js";
import { probeAgent } from "./agents/models.js";
import { SELF_MENTION } from "./agents/mentions.js";

/**
 * Who answers a run, as RunService routes it: a preset picked for the run is Jolo's own provider, else the run's agent,
 * else the conversation's. The title goes to the same answerer, so a prompt never reaches a provider the run does not.
 * `agentModel` is the model chosen for that agent, when one was. @returns {{ agentId: string | null, agentModel: string | null }}
 */
const answererOf = (session, execution) => {
  const agentId = execution?.preset ? null : execution?.agentId ?? session.agentId ?? null;
  if (!agentId || agentId === SELF_MENTION) return { agentId: null, agentModel: null };
  const own = execution?.agentId === agentId ? execution.model ?? null : null;
  return { agentId, agentModel: own ?? (agentId === session.agentId ? session.agentModel?.model ?? null : null) };
};

/** The instructions for the title model. */
export const TITLE_INSTRUCTIONS = 'You name conversations. Given the first message of a conversation with a coding assistant, reply with a short title for it: three to seven words, in the language of the message, no quotes, no trailing period. Reply with the title and nothing else.';

const TIMEOUT_MS = 20_000;
/** The whole prompt is not needed for a name. */
const PROMPT_MAX = 4_000;
const TITLE_MAX = 80;
const ANSWER_MAX_BYTES = 1_024;
/** A tier name as a whole part of a model id: `gpt-5-mini` and `claude-haiku-4-5`, never `minimax-m2`. */
const SMALL_TIER = /(?:^|[^a-z0-9])(?:haiku|mini|nano|flash|lite|small)(?:$|[^a-z0-9])/i;
/** Small models that do not chat (`gpt-4o-mini-tts`, `text-embedding-3-small`), which a provider's listing mixes in. */
const NOT_CHAT = /tts|transcribe|realtime|audio|embed|whisper|moderation|image|vision|search/i;
/** The least thought first: minimal, then low, then any other effort from the lowest up. */
const EFFORT_PREFERENCE = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** Room for the thought a reasoning model's default effort may spend before the title; it only bounds the worst case. */
const TITLE_OUTPUT_TOKENS = 1_024;
/** Claude Code always knows this alias: the model when the chat chose none, and the stand-in when its list has no small tier or cannot be read. */
const CLAUDE_SMALL_ALIAS = "haiku";
/** The quotes a model wraps a title in, each opening one with its closing one. */
const QUOTE_PAIRS = new Map([['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"], ["«", "»"]]);
/** Markdown emphasis a model wraps a title in, the longer marks first. */
const EMPHASIS = ["**", "__", "*", "_"];
/** A leading Markdown heading or list marker. */
const LINE_MARKER = /^(?:#{1,6}|[-*•])\s+/;
/** `Title:`, bold or not. */
const TITLE_LABEL = /^(?:\*\*|__)?title(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*/i;

/** A model id that names a small tier and chats. */
const smallChat = (id) => typeof id === "string" && SMALL_TIER.test(id) && !NOT_CHAT.test(id);

/**
 * The cheapest of an answerer's models: the current model when it is a small chat model itself; else the first whose
 * id names a small tier (haiku, mini, nano, flash, lite, small), in the order the list gives them, passing over speech,
 * realtime, embedding, image and search variants; else the current model.
 * @param {{ id: string }[]} models @param {string} current @returns {{ id: string }}
 */
export function cheapestModel(models, current) {
  const listed = Array.isArray(models) ? models : [];
  const own = listed.find((model) => model?.id === current) ?? { id: current };
  if (smallChat(current)) return own;
  return listed.find((model) => smallChat(model?.id)) ?? own;
}

/** One pair of quotes or emphasis taken off, only when it wraps the whole text: the inside holds no such mark. */
function unwrap(text) {
  const close = QUOTE_PAIRS.get(text[0]);
  if (close && text.length >= 2 && text.at(-1) === close) {
    const inner = text.slice(1, -1);
    if (!inner.includes(text[0]) && !inner.includes(close)) return inner;
  }
  for (const mark of EMPHASIS) {
    if (text.length > mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
      const inner = text.slice(mark.length, -mark.length);
      if (!inner.includes(mark)) return inner;
    }
  }
  return text;
}

/** One line as a title: whitespace collapsed, Markdown, quotes, `Title:` and a trailing period gone; empty without words. */
function cleanLine(line) {
  let title = line.replace(/\s+/g, " ").trim();
  for (let previous = null; previous !== title;) {
    previous = title;
    title = unwrap(title.replace(LINE_MARKER, "").replace(TITLE_LABEL, "")).replace(/(?<!\.)\.$/, "").trim();
  }
  return /[\p{L}\p{N}]/u.test(title) ? title : "";
}

/**
 * The title in what a model answered: the first line that still has words once a leading heading or list marker,
 * wrapping emphasis, quotes or backticks (a pair that wraps the whole line), a leading `Title:` and a trailing period
 * (an ellipsis stays) are gone, whitespace collapsed. Over 80 characters it is cut at the last space when that space
 * is past the halfway mark, else at 80, so a Chinese or Japanese title with one early space keeps more than a word.
 * @param {unknown} answer @returns {string | null}
 */
export function titleFromAnswer(answer) {
  if (typeof answer !== "string") return null;
  let title = "";
  for (const line of answer.split(/\r?\n/)) if ((title = cleanLine(line))) break;
  const points = Array.from(title);
  if (points.length > TITLE_MAX) {
    const space = points.lastIndexOf(" ", TITLE_MAX);
    title = points.slice(0, space > TITLE_MAX / 2 ? space : TITLE_MAX).join("").trim();
  }
  return title || null;
}

const reasonOf = (error) => String(error?.message ?? error).slice(0, 300);

/**
 * The least thought a model lists: `minimal` before `low` before the rest from the lowest up. Otherwise no effort at all,
 * as a run without an effort choice has, which every adapter already works with: when it lists none, is not listed, or
 * thinks on a budget. Only Anthropic's listing names efforts, and its budgeted thinking needs more output than a title
 * is given (anthropic.js wants above 1024 tokens), so only adaptive thinking takes one.
 * @param {{ id?: string, efforts?: string[], thinkingMode?: string } | undefined} model @returns {string | null}
 */
const effortFor = (model) => (model?.thinkingMode === "adaptive" && EFFORT_PREFERENCE.find((effort) => Array.isArray(model.efforts) && model.efforts.includes(effort))) || null;

/**
 * `claims(session, execution)` says, cheaply and synchronously, whether the service names this task: its answerer (the
 * first run's, given its `execution`, see answererOf) is a configured
 * Jolo provider (not the demo provider, not a local Ollama listing) or Claude Code. It stays true while the task is
 * being named, so a second prompt in that time does not write its own first characters over the blank title.
 * `suggest(session, prompt, execution)` asks that answerer for a title for the first prompt and writes it while the title is blank;
 * when that fails it names the task after the prompt's first characters. One attempt per task at a time: a second call
 * while one is under way does nothing. It never throws: its promise settles with the title written, or null.
 * `JOLO_AUTO_TITLE=0` (or `off`) turns the service off, and then there is none.
 * @param {{ storage: any, providerFactory?: any, catalog?: any, agentModels?: any, supervisor?: any, log?: any, env?: Record<string, string | undefined>, timeoutMs?: number }} deps
 * @returns {{ claims: (session: any, execution?: any) => boolean, suggest: (session: any, prompt: string, execution?: any) => Promise<string | null> } | null}
 */
export function createTitleService({ storage, providerFactory, catalog, agentModels, supervisor, log, env = process.env, timeoutMs = TIMEOUT_MS }) {
  if (/^(?:0|off)$/i.test(String(env?.JOLO_AUTO_TITLE ?? "").trim())) return null;
  /** Tasks being named now; an entry leaves when its attempt ends, whichever way. */
  const naming = new Set();
  // The engine's log has no debug level; there a failed title is an info line, never anything the person sees.
  const note = (message, fields) => (log?.debug ?? log?.info)?.call(log, message, fields);

  /** A task Jolo answers: its own provider, on the cheapest model that provider lists. */
  const fromProvider = async (session, execution, text, signal) => {
    const captured = providerFactory?.capture(session, execution);
    if (!captured) return null; // nothing is configured; the task's run says so itself
    if (captured.endpoint?.protocol === "fake") return null; // the demo provider has no model to name a task with
    // A local model server (an Ollama listing; the catalog has no other mark of "local") answers one request at a time,
    // so a title would hold up the task's own first request.
    if (captured.endpoint?.listing === "ollama") return null;
    const { ref } = captured;
    let listed = null;
    try { listed = await providerFactory.models(ref.preset); } catch { /* the task's own model stands in */ }
    const cheap = cheapestModel(listed?.models, ref.model);
    const listedOwn = Array.isArray(listed?.models) ? listed.models.find((model) => model?.id === ref.model) : undefined;
    const own = { ...ref, effort: effortFor(listedOwn) };
    // A cheap model that cannot be made (one reporting no tool support, say) gives way to the task's own, once.
    const choices = cheap.id === ref.model ? [own] : [{ preset: ref.preset, model: cheap.id, effort: effortFor(cheap) }, own];
    let made = null;
    for (const [index, choice] of choices.entries()) {
      try { made = await providerFactory.create(choice); break; }
      catch (error) { if (index === choices.length - 1) throw error; note("title model unavailable; trying the task's own", { sessionId: session.id, model: choice.model, reason: reasonOf(error) }); }
    }
    const request = {
      sessionId: session.id, runId: null, purpose: "title", instructions: TITLE_INSTRUCTIONS,
      items: [{ kind: "user_message", groupId: "title", payload: { text } }], tools: [], maxOutputTokens: TITLE_OUTPUT_TOKENS,
    };
    return collectSummary(made.provider, request, signal, ANSWER_MAX_BYTES, 1);
  };

  /**
   * A task Claude Code answers: one print-mode process, one answer, as model discovery asks it. The prompt goes on stdin,
   * which is closed right after it, so it never shows on the command line (where `ps` would show it, and where it could be
   * read as an option or a subcommand) and Claude reads it at once; the guardian's grace after that EOF, 1.5 s by
   * default, is raised to this process's deadline, and the timeout still ends a process that hangs.
   * Not `--bare`: it reads only an API key, never the OAuth sign-in a subscription uses, and the hosted environment
   * carries no key. Empty setting sources keep the user's, project's and local settings out, and with them their hooks
   * and plugins, and the strict MCP configuration with none given keeps the user's MCP servers from starting; no tools
   * keeps Claude's own system prompt small (about 880 tokens instead of about 28k). `--tools` takes several values, so a
   * flag always follows its empty one and it can never take the prompt.
   * The model is the task's own when that is already small; with none chosen, the `haiku` alias, without listing; with
   * a larger one chosen, the first small model Claude lists, else the alias.
   */
  const fromClaude = async (agentModel, manifest, text, deadline) => {
    const chosen = agentModel ?? catalog.config?.(manifest)?.model ?? CLAUDE_SMALL_ALIAS;
    let listed = null;
    if (!smallChat(chosen)) try { listed = await agentModels.list(manifest.id); } catch { /* the alias stands in */ }
    const pick = cheapestModel(listed?.models, chosen).id;
    const model = smallChat(pick) ? pick : CLAUDE_SMALL_ALIAS;
    const [binary, ...extraArgs] = catalog.command(manifest, { model: null, effort: null, fast: null });
    const argv = [binary, ...extraArgs, "--print", "--output-format", "json", "--model", model, "--no-session-persistence", "--setting-sources", "", "--tools", "", "--strict-mcp-config", "--max-turns", "1", "--system-prompt", TITLE_INSTRUCTIONS];
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no answer within ${timeoutMs / 1000} s`);
    const answer = await probeAgent({ supervisor, log }, manifest, argv, remaining, {
      open: () => {}, input: text, closeStdin: true, env: { JOLO_GUARDIAN_EOF_GRACE_MS: String(remaining) },
      ask: (message) => {
        if (message?.type !== "result") return null;
        // An error is a result too, and with subtype "success" when it is the sign-in that failed.
        if (message.subtype === "success" && message.is_error !== true && typeof message.result === "string") return { title: message.result };
        return { failure: `${manifest.displayName} answered ${message.subtype ?? "a result without a subtype"}${message.is_error ? " (an error)" : ""}` };
      },
    });
    if (typeof answer.title === "string") return answer.title;
    throw new Error(answer.failure ?? answer.note ?? `${manifest.displayName} did not answer`);
  };

  /** The prompt's first characters, while the title is still blank: a task is never left unnamed. */
  const fallBack = (sessionId, prompt) => {
    try { storage.transaction(() => storage.assignSessionTitle(sessionId, prompt)); }
    catch (error) { note("task not named after its prompt either", { sessionId, reason: reasonOf(error) }); }
  };

  return {
    claims(session, execution = null) {
      try {
        if (!session?.id) return false;
        const { agentId } = answererOf(session, execution);
        // Codex, ACP agents and Antigravity are not asked yet: their tasks are named after the prompt at once.
        if (agentId) return catalog?.get(agentId)?.transport === "claude-stream";
        const captured = providerFactory?.capture(session, execution);
        return Boolean(captured) && captured.endpoint?.protocol !== "fake" && captured.endpoint?.listing !== "ollama";
      } catch {
        return false;
      }
    },

    async suggest(session, prompt, execution = null) {
      const sessionId = session?.id ?? null;
      if (!sessionId || naming.has(sessionId)) return null; // the attempt under way names it, or falls back
      try { if (String(storage.getSession(sessionId)?.title ?? "x").trim()) return null; } // named meanwhile, or gone
      catch (error) { note("task title not suggested", { sessionId, reason: reasonOf(error) }); return null; }
      naming.add(sessionId);
      const controller = new AbortController();
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(() => controller.abort(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
      try {
        const text = Array.from(String(prompt ?? "").trim()).slice(0, PROMPT_MAX).join("");
        if (!text) return null;
        let answer;
        const { agentId, agentModel } = answererOf(session, execution);
        if (!agentId) answer = await fromProvider(session, execution, text, controller.signal);
        else {
          const manifest = catalog.get(agentId);
          if (manifest.transport !== "claude-stream") throw new Error(`${manifest.displayName} is not asked for titles`);
          answer = await fromClaude(agentModel, manifest, text, deadline);
        }
        if (answer === null) throw new Error("this task's provider is not asked for titles");
        if (controller.signal.aborted) throw controller.signal.reason;
        const title = titleFromAnswer(answer);
        if (!title) throw new Error("the answer held no title");
        return storage.replaceBlankTitle(sessionId, title) ? title : null; // false: renamed or deleted meanwhile
      } catch (error) {
        note("task title not suggested", { sessionId, reason: reasonOf(error) });
        fallBack(sessionId, prompt);
        return null;
      } finally {
        clearTimeout(timer);
        naming.delete(sessionId);
      }
    },
  };
}
