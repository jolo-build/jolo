// Answering the dialog the terminal client shows (Claude's question, or its plan to approve) from the keyboard: what a key
// does with the draft as it is, what the live hint says, and the answer that goes back. Pure, so the keys are testable.
import { answerFor, dialogKind, dismissMessage, readQuestions } from "@jolo/client/dialogs";

/**
 * @typedef {{ dialogId: string, tool: string, kind: import("@jolo/client/dialogs").DialogKind, questions: import("@jolo/client/dialogs").Question[], index: number, answers: string[], picked: number[] }} DialogAnswer
 * The question being answered is `questions[index]`; `picked` holds the option numbers ticked in a multi-select so far.
 * @typedef {{ type: "resolve", response: Record<string, unknown> } | { type: "dismiss", message: string } | { type: "state", state: DialogAnswer } | { type: "ignore" } | { type: "edit" }} DialogAction
 * `edit` hands the key to the draft; `ignore` swallows it.
 */

/** @param {import("@jolo/client/dialogs").Dialog & { dialogId: string }} dialog @returns {DialogAnswer} */
export function createDialogAnswer(dialog) {
  const kind = dialogKind(dialog);
  return { dialogId: dialog.dialogId, tool: dialog.tool, kind, questions: kind === "question" ? readQuestions(dialog.input) : [], index: 0, answers: [], picked: [] };
}

/** The question's answer recorded, and the next question up, or the whole answer sent once every question has one. */
const answered = (/** @type {DialogAnswer} */ state, /** @type {string} */ answer) => {
  const answers = [...state.answers.slice(0, state.index), answer];
  if (answers.length < state.questions.length) return /** @type {DialogAction} */ ({ type: "state", state: { ...state, index: state.index + 1, answers, picked: [] } });
  return /** @type {DialogAction} */ ({ type: "resolve", response: { answers: Object.fromEntries(state.questions.map((question, i) => [question.question, answers[i]])) } });
};

/**
 * What a key does. Digits pick options only while the draft is empty, so a number inside typed words stays text; letters
 * are never shortcuts, so feedback or an answer can begin with any of them.
 * @param {DialogAnswer} state @param {{ chunk: string, key: any, draft: string }} input @returns {DialogAction}
 */
export function dialogKey(state, { chunk, key, draft }) {
  const typed = draft.trim();
  const dismiss = (/** @type {string} */ message = dismissMessage(state.tool)) => /** @type {DialogAction} */ ({ type: "dismiss", message });
  if (state.kind === "truncated" || state.kind === "unreadable") return key.return || key.escape ? dismiss() : { type: "ignore" };
  if (key.escape) return dismiss();
  if (state.kind === "other") return key.return ? { type: "resolve", response: {} } : { type: "ignore" };
  if (state.kind === "plan") return key.return ? (typed ? dismiss(typed) : { type: "resolve", response: {} }) : { type: "edit" };
  const question = state.questions[state.index];
  if (key.return) {
    if (typed) { const answer = answerFor(question, typed); return answer === null ? { type: "ignore" } : answered(state, answer); }
    if (!state.picked.length) return { type: "ignore" };
    return answered(state, question.options.filter((_, i) => state.picked.includes(i + 1)).map((option) => option.label).join(", "));
  }
  if (!typed && /^[1-9]$/.test(chunk) && !key.ctrl && !key.meta) {
    const number = Number(chunk);
    if (number > question.options.length) return { type: "ignore" };
    if (!question.multiSelect) return answered(state, question.options[number - 1].label);
    return { type: "state", state: { ...state, picked: state.picked.includes(number) ? state.picked.filter((n) => n !== number) : [...state.picked, number] } };
  }
  return { type: "edit" };
}

/** The live line under the card: which question is up, what is picked, and the keys. @param {DialogAnswer} state @param {string} draft */
export function dialogHint(state, draft) {
  if (state.kind === "truncated" || state.kind === "unreadable") return "Enter or Esc dismisses";
  if (state.kind === "other") return "Enter allows · Esc dismisses";
  if (state.kind === "plan") return "Enter approves · type what should change, Enter sends it back · Esc sends it back";
  const question = state.questions[state.index];
  const which = state.questions.length === 1 ? "Question" : `Question ${state.index + 1} of ${state.questions.length}${question.header ? ` (${question.header})` : ""}`;
  const picked = state.picked.length ? ` · picked: ${question.options.filter((_, i) => state.picked.includes(i + 1)).map((option) => option.label).join(", ")}` : "";
  const range = question.options.length ? `[1]–[${question.options.length}] pick` : "";
  const keys = question.multiSelect ? `${range} several · Enter answers · type an answer` : `${range ? `${range} · ` : ""}type an answer, Enter sends`;
  return `${which}: ${question.question}${picked} · ${keys} · Esc dismisses`;
}

/** What the empty composer says while the dialog is shown. @param {DialogAnswer} state */
export function dialogPlaceholder(state) {
  return state.kind === "question" ? "Your answer…" : state.kind === "plan" ? "What should change? (optional)" : "";
}
