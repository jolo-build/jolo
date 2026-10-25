import { useRef, useState } from 'react';
import { Modal } from './modal.jsx';
import { Markdown } from './markdown.jsx';

/** @typedef {{ label: string, description: string }} Option */
/** @typedef {{ question: string, header: string, options: Option[], multiSelect: boolean }} Question */
/** @typedef {{ picked: string[], other: boolean, text: string }} Choice The options ticked, whether Other is, and its text. */
/** @typedef {{ dialogId: string, runId: string, tool: string, input: any, toolUseId: string | null }} Dialog */

const QUESTION = 'Claude has a question';
const PLAN = 'Plan ready for your review';
// What Claude reads when the person turns the dialog away (claude-dialogs.md); a plan sent back carries their feedback instead.
const DISMISSED = { AskUserQuestion: 'The user dismissed the question without answering.', ExitPlanMode: 'The user rejected the plan.' };
const DISMISSED_REQUEST = 'The user dismissed the request.';
const PRIMARY = { question: 'Answer', plan: 'Approve plan', other: 'Allow' };
// A question or plan the card cannot show in full can only be turned away: allowing it would tell Claude it was answered.
const DISMISS_ONLY = { truncated: 'This question is too long to show here.', unreadable: 'This question could not be shown.' };
/** @type {Choice} */
const NO_CHOICE = Object.freeze({ picked: [], other: false, text: '' });

const text = (/** @type {unknown} */ value) => typeof value === 'string' ? value : '';

/**
 * An AskUserQuestion input's questions, read so that no shape throws (Review Focus 2): a truncated input has none, a
 * question without text is left out, one without options keeps only Other, and an option without a label is left out.
 * @param {any} input @returns {Question[]}
 */
function readQuestions(input) {
  const list = Array.isArray(input?.questions) ? input.questions : [];
  return list.map(item => ({
    question: text(item?.question),
    header: text(item?.header),
    options: (Array.isArray(item?.options) ? item.options : []).map(option => ({ label: text(option?.label), description: text(option?.description) })).filter(option => option.label),
    multiSelect: item?.multiSelect === true,
  })).filter(question => question.question);
}

/** @param {Question} question @param {Choice} choice */
function answerOf(question, choice) {
  const typed = choice.other ? choice.text.trim() : '';
  return [...question.options.map(option => option.label).filter(label => choice.picked.includes(label)), ...(typed ? [typed] : [])].join(', ');
}

/**
 * The `answers` Claude Code reads from the tool input, keyed by question text: the chosen label, the chosen labels in
 * option order joined with `, ` for a multi-select, the typed text for Other. Null until every question has an answer.
 * @param {Question[]} questions @param {Choice[]} choices @returns {Record<string, string> | null}
 */
export function answersFor(questions, choices) {
  if (!questions.length) return null;
  /** @type {Record<string, string>} */
  const answers = {};
  for (const [index, question] of questions.entries()) {
    const answer = answerOf(question, choices[index] ?? NO_CHOICE);
    if (!answer) return null;
    answers[question.question] = answer;
  }
  return answers;
}

/** The line a notice shows for a dialog (D8's wording): its first question, the plan note, or the tool's name. @param {{ tool: string, input: any }} dialog */
export function dialogSummary({ tool, input }) {
  if (tool === 'ExitPlanMode') return PLAN;
  return readQuestions(input)[0]?.question || tool;
}

/** @param {{ index: number, question: Question, choice: Choice, disabled: boolean, onChange: (choice: Choice) => void }} props */
function QuestionGroup({ index, question, choice, disabled, onChange }) {
  const { multiSelect } = question;
  const type = multiSelect ? 'checkbox' : 'radio';
  const name = `q-${index}`;
  // A single-select answer is one option or Other; a multi-select may tick several and Other besides.
  const pick = (/** @type {string} */ label, /** @type {boolean} */ checked) => onChange(multiSelect
    ? { ...choice, picked: checked ? [...choice.picked, label] : choice.picked.filter(item => item !== label) }
    : { ...choice, picked: [label], other: false });
  const other = (/** @type {boolean} */ checked, typed = choice.text) => onChange({ picked: multiSelect ? choice.picked : [], other: checked, text: typed });
  return <fieldset className="dialog-question" disabled={disabled}>
    <legend>{question.header && <span className="modal-eyebrow">{question.header}</span>}<span>{question.question}</span></legend>
    {question.options.map((option, i) => <label className="dialog-option" key={i}>
      <input type={type} name={name} checked={choice.picked.includes(option.label)} onChange={event => pick(option.label, event.target.checked)} />
      <span><span>{option.label}</span>{option.description && <span className="hint">{option.description}</span>}</span>
    </label>)}
    <div className="dialog-option dialog-other">
      <label><input type={type} name={name} checked={choice.other} onChange={event => other(event.target.checked)} /><span>Other</span></label>
      <input type="text" aria-label="Other answer" value={choice.text} onChange={event => other(true, event.target.value)} />
    </div>
  </fieldset>;
}

/**
 * A question from Claude or a plan to approve (D5), shown like a permission request: one decision, then the card goes
 * when the engine settles the dialog. Another tool's input shows as JSON; a question or plan that is truncated, or whose
 * input cannot be read, can only be dismissed.
 * @param {{ dialog: Dialog, onResolve: (response: object) => Promise<unknown>, onDismiss: (message: string) => Promise<unknown> }} props
 */
export function DialogModal({ dialog, onResolve, onDismiss }) {
  const { dialogId, tool, input } = dialog;
  const questions = readQuestions(input);
  const kind = input?.truncated === true ? 'truncated'
    : tool === 'AskUserQuestion' ? (questions.length ? 'question' : 'unreadable')
    : tool === 'ExitPlanMode' ? (typeof input?.plan === 'string' ? 'plan' : 'unreadable')
    : 'other';
  const dismissOnly = kind === 'truncated' || kind === 'unreadable';
  const [choices, setChoices] = useState(() => questions.map(() => NO_CHOICE));
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const deciding = useRef(false);
  const primary = useRef(null);
  const dismissButton = useRef(null);
  const answers = kind === 'question' ? answersFor(questions, choices) : null;
  const canApprove = kind === 'question' ? answers !== null : !dismissOnly;
  const title = tool === 'ExitPlanMode' ? PLAN : QUESTION;
  const decide = async (/** @type {() => Promise<unknown>} */ action) => {
    if (deciding.current) return;
    deciding.current = true;
    setPending(true); setError(null);
    try { await action(); }
    catch (e) { deciding.current = false; setError(e.message); setPending(false); }
  };
  const approve = () => decide(() => onResolve(kind === 'question' ? { answers } : {}));
  const dismiss = () => decide(() => onDismiss((kind === 'plan' && feedback.trim()) || (DISMISSED[tool] ?? DISMISSED_REQUEST)));
  return <Modal label={title} onClose={dismiss} dismissOnBackdrop={false} initialFocus={dismissOnly ? dismissButton : kind === 'question' ? undefined : primary} className="dialog-modal" onKeyDown={event => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    // Holding Enter must not answer a second dialog that appears after this one.
    if (event.repeat || deciding.current) { event.preventDefault(); return; }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Handle the primary action directly; other controls, and the plan's links, retain their native behavior.
    const control = /** @type {Element} */ (event.target).closest('a[href], button, input, select, summary, textarea, [contenteditable="true"]');
    if (control && control !== primary.current) return;
    event.preventDefault();
    if (canApprove) void approve();
  }}>
    <h2>{title}</h2>
    {dismissOnly && <>
      <p className="hint">{DISMISS_ONLY[kind]}</p>
      <div className="command-card"><pre className="command">{kind === 'truncated' ? text(input.preview) : JSON.stringify(input ?? null, null, 2)}</pre></div>
    </>}
    {kind === 'question' && questions.map((question, index) => <QuestionGroup key={index} index={index} question={question} choice={choices[index] ?? NO_CHOICE} disabled={pending}
      onChange={choice => setChoices(current => current.map((item, i) => i === index ? choice : item))} />)}
    {kind === 'plan' && <>
      <div className="plan-body"><Markdown text={input.plan} cacheKey={dialogId} /></div>
      <textarea placeholder="What should change? (optional)" aria-label="What should change? (optional)" value={feedback} disabled={pending} onChange={event => setFeedback(event.target.value)} />
    </>}
    {kind === 'other' && <div className="command-card"><pre className="command">{JSON.stringify(input ?? null, null, 2)}</pre><div className="hint">{tool}</div></div>}
    {error && <p className="negative" role="alert">{error}</p>}
    <div className="modal-actions">
      <button ref={dismissButton} className="outline" disabled={pending} onClick={dismiss}>{kind === 'plan' ? 'Send back' : 'Dismiss'}</button>
      {!dismissOnly && <button ref={primary} className="primary" disabled={pending || !canApprove} onClick={approve}>{PRIMARY[kind]}</button>}
    </div>
  </Modal>;
}
