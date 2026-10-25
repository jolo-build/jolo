// A dialog from Claude (a question, a plan to approve) as plain terminal lines, the same for `jolo run`'s stderr and the
// interactive client's card; each caller adds its own line on how to answer (a command there, keys here).
import { dialogKind, PLAN_SUMMARY, readQuestions } from "@jolo/client/dialogs";

const MAX_JSON_LINES = 40;
const DISMISS_ONLY = { truncated: "Claude's question is too long to show here; it can only be dismissed.", unreadable: "Claude's request could not be shown; it can only be dismissed." };

/** @param {import("@jolo/client/dialogs").Question} question */
const optionLines = (question) => [
  ...question.options.map((option, index) => `  [${index + 1}] ${option.label}${option.description ? ` — ${option.description}` : ""}`),
  `  ${question.multiSelect ? `pick several as ${question.options.length > 1 ? "1,2" : "1"} · ` : ""}or type your own answer`,
];

/**
 * The lines that show a dialog: a question with its options numbered (several questions numbered in turn), a plan in
 * full under its heading, a notice for one that can only be dismissed, or another tool's input as JSON.
 * @param {import("@jolo/client/dialogs").Dialog} dialog @returns {string[]}
 */
export function dialogLines(dialog) {
  const kind = dialogKind(dialog);
  if (kind === "truncated") return [DISMISS_ONLY.truncated, ...(typeof dialog.input.preview === "string" ? [dialog.input.preview] : [])];
  if (kind === "unreadable") return [DISMISS_ONLY.unreadable];
  if (kind === "plan") return [PLAN_SUMMARY, ...String(dialog.input.plan).split("\n")];
  if (kind === "question") {
    const questions = readQuestions(dialog.input);
    if (questions.length === 1) return [`Claude asks: ${questions[0].question}`, ...optionLines(questions[0])];
    return [`Claude asks ${questions.length} questions.`, ...questions.flatMap((question, index) => [
      `Question ${index + 1} of ${questions.length}${question.header ? ` (${question.header})` : ""}: ${question.question}`, ...optionLines(question),
    ])];
  }
  const json = JSON.stringify(dialog.input ?? null, null, 2).split("\n");
  return [`Claude asks (${dialog.tool}):`, ...json.slice(0, MAX_JSON_LINES), ...(json.length > MAX_JSON_LINES ? [`… ${json.length - MAX_JSON_LINES} more lines`] : [])];
}
