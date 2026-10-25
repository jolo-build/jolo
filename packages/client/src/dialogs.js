// Claude's questions to the person (AskUserQuestion) and plan approvals (ExitPlanMode), as `dialog.requested` carries
// them, read so that no shape throws, and the answer built the way Claude Code reads it: `answers` keyed by question
// text, a chosen option's label, several labels joined with `, ` for a multi-select, or the person's own text.
// Shared by the terminal client and `jolo dialog`, whose prompts are plain text: an option is picked by its number.

/** @typedef {{ label: string, description: string }} Option */
/** @typedef {{ question: string, header: string, options: Option[], multiSelect: boolean }} Question */
/** @typedef {{ dialogId?: string, runId?: string, tool: string, input: any, toolUseId?: string | null }} Dialog */
/** @typedef {'question' | 'plan' | 'truncated' | 'unreadable' | 'other'} DialogKind */

export const PLAN_SUMMARY = "Plan ready for your review";
// What Claude reads when the person turns the dialog away (claude-dialogs.md); a plan sent back carries their feedback instead.
const DISMISSED = { AskUserQuestion: "The user dismissed the question without answering.", ExitPlanMode: "The user rejected the plan." };
const DISMISSED_REQUEST = "The user dismissed the request.";

const text = (/** @type {unknown} */ value) => typeof value === "string" ? value : "";

/**
 * An AskUserQuestion input's questions: a truncated input has none, a question without text is left out, one without
 * options keeps only the person's own text as an answer, and an option without a label is left out.
 * @param {any} input @returns {Question[]}
 */
export function readQuestions(input) {
  const list = Array.isArray(input?.questions) ? input.questions : [];
  return list.map((item) => ({
    question: text(item?.question),
    header: text(item?.header),
    options: (Array.isArray(item?.options) ? item.options : []).map((option) => ({ label: text(option?.label), description: text(option?.description) })).filter((option) => option.label),
    multiSelect: item?.multiSelect === true,
  })).filter((question) => question.question);
}

/**
 * What kind of dialog this is. A question or plan too long for its event (`truncated`), or whose input cannot be read,
 * can only be dismissed: answering it would tell Claude it was answered.
 * @param {Dialog} dialog @returns {DialogKind}
 */
export function dialogKind({ tool, input }) {
  if (input?.truncated === true) return "truncated";
  if (tool === "AskUserQuestion") return readQuestions(input).length ? "question" : "unreadable";
  if (tool === "ExitPlanMode") return typeof input?.plan === "string" ? "plan" : "unreadable";
  return "other";
}

/**
 * The answer a typed choice stands for: an option's number its label, several numbers (a multi-select) their labels in
 * option order, and anything else the typed text itself. Null for nothing, a number no option has, or several numbers to
 * a question that takes one answer.
 * @param {Question} question @param {string} choice @returns {string | null}
 */
export function answerFor(question, choice) {
  const typed = choice.trim();
  if (!typed) return null;
  if (!/^\d+(\s*,\s*\d+)*$/.test(typed)) return typed;
  const picked = new Set(typed.split(",").map((part) => Number(part.trim())));
  if (!question.multiSelect && picked.size > 1) return null;
  if ([...picked].some((index) => index < 1 || index > question.options.length)) return null;
  return question.options.filter((_, index) => picked.has(index + 1)).map((option) => option.label).join(", ");
}

/**
 * The `answers` Claude Code reads from the tool input, keyed by question text; null until every question has an answer.
 * @param {Question[]} questions @param {string[]} choices @returns {Record<string, string> | null}
 */
export function answersFor(questions, choices) {
  if (!questions.length) return null;
  /** @type {Record<string, string>} */
  const answers = {};
  for (const [index, question] of questions.entries()) {
    const answer = answerFor(question, choices[index] ?? "");
    if (answer === null) return null;
    answers[question.question] = answer;
  }
  return answers;
}

/** What Claude reads when the person turns a dialog of this tool away without answering. @param {string} tool */
export const dismissMessage = (tool) => DISMISSED[tool] ?? DISMISSED_REQUEST;

/** The line a dialog is summed up as: its first question, the plan note, or the tool's name. @param {Dialog} dialog */
export function dialogSummary({ tool, input }) {
  if (tool === "ExitPlanMode") return PLAN_SUMMARY;
  return readQuestions(input)[0]?.question || tool;
}
