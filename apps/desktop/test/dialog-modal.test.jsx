import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { answersFor, DialogModal, dialogSummary } from '../src/renderer/components/dialog-modal.jsx';

const noop = async () => {};
/** @param {string} tool @param {any} input */
const render = (tool, input) => renderToStaticMarkup(<DialogModal dialog={{ dialogId: 'dlg_1', runId: 'run_1', tool, input, toolUseId: 'toolu_1' }} onResolve={noop} onDismiss={noop} />);
const count = (/** @type {string} */ html, /** @type {RegExp} */ pattern) => html.match(pattern)?.length ?? 0;
const button = (/** @type {string} */ html, /** @type {string} */ label) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? null;
const drink = { question: 'Do you prefer tea or coffee?', header: 'Drink', options: [{ label: 'Tea', description: 'You prefer tea.' }, { label: 'Coffee', description: 'You prefer coffee.' }], multiSelect: false };
const plan = '# Plan: Create hello.txt\n\n1. Write the file.';

test('a question shows its header, its options as radios with their descriptions, an Other row, and a disabled Answer', () => {
  const html = render('AskUserQuestion', { questions: [drink] });
  expect(html).toContain('dialog-modal');
  expect(html).toContain('Drink');
  expect(html).toContain('Do you prefer tea or coffee?');
  expect(count(html, /type="radio" name="q-0"/g)).toBe(3); // Tea, Coffee and Other
  expect(html).toContain('>Tea<');
  expect(html).toContain('>Coffee<');
  expect(html).toContain('<span class="hint">You prefer coffee.</span>');
  expect(html).toContain('>Other<');
  expect(count(html, /type="text"/g)).toBe(1);
  expect(button(html, 'Answer')).toContain('disabled=""');
  expect(button(html, 'Dismiss')).not.toContain('disabled=""');
});

test('a multi-select question offers checkboxes, each question its own group', () => {
  const html = render('AskUserQuestion', { questions: [drink, { ...drink, question: 'Which toppings?', header: 'Toppings', multiSelect: true }] });
  expect(count(html, /type="radio" name="q-0"/g)).toBe(3);
  expect(count(html, /type="checkbox" name="q-1"/g)).toBe(3);
  expect(html).toContain('Which toppings?');
});

test('a plan approval shows the plan, a feedback field, Send back and Approve plan', () => {
  const html = render('ExitPlanMode', { plan, planFilePath: '/plans/hello.md' });
  expect(html).toContain('Plan: Create hello.txt');
  expect(html).toContain('class="plan-body"');
  expect(html).toContain('placeholder="What should change? (optional)"');
  expect(button(html, 'Send back')).not.toBeNull();
  expect(button(html, 'Approve plan')).not.toContain('disabled=""');
  expect(button(html, 'Answer')).toBeNull();
});

test('a truncated input says it is too long, shows the preview, and offers Dismiss only (Review Focus 2)', () => {
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'SomeFutureDialog']) {
    const html = render(tool, { truncated: true, preview: '{"questions":[{"question":"Which of these' });
    expect(html).toContain('This question is too long to show here.');
    expect(html).toContain('{&quot;questions&quot;:[{&quot;question&quot;:&quot;Which of these');
    expect(button(html, 'Dismiss')).not.toBeNull();
    for (const label of ['Answer', 'Approve plan', 'Send back', 'Allow']) expect(button(html, label)).toBeNull();
  }
});

test('any other tool shows its input as JSON with Allow and Dismiss', () => {
  const html = render('SomeFutureDialog', { title: 'Pick a colour' });
  expect(html).toContain('&quot;title&quot;: &quot;Pick a colour&quot;');
  expect(button(html, 'Allow')).not.toContain('disabled=""');
  expect(button(html, 'Dismiss')).not.toBeNull();
});

test('inputs of an unexpected shape never throw', () => {
  const noOptions = render('AskUserQuestion', { questions: [{ question: 'What should the file be called?', header: 'Name' }] });
  expect(noOptions).toContain('What should the file be called?');
  expect(count(noOptions, /type="radio" name="q-0"/g)).toBe(1); // only Other
  expect(() => render('AskUserQuestion', { questions: [null, 'text', { question: 5, options: 'none' }, { options: [null, 'x', { label: 7 }] }] })).not.toThrow();
});

test('a question or plan whose input cannot be read shows it and offers Dismiss only, never an empty answer', () => {
  const unreadable = [
    ['AskUserQuestion', {}], ['AskUserQuestion', null], ['AskUserQuestion', { questions: 'none' }],
    ['AskUserQuestion', { questions: [null, 'text', { question: 5, options: 'none' }, { options: [null, 'x', { label: 7 }] }] }],
    ['ExitPlanMode', { plan: 42 }], ['ExitPlanMode', {}],
  ];
  for (const [tool, input] of unreadable) {
    const html = render(/** @type {string} */ (tool), input);
    expect(html).toContain('This question could not be shown.');
    expect(html).not.toContain('too long to show');
    expect(button(html, 'Dismiss')).not.toBeNull();
    for (const label of ['Answer', 'Approve plan', 'Send back', 'Allow']) expect(button(html, label)).toBeNull();
  }
  expect(render('ExitPlanMode', { plan: 42 })).toContain('&quot;plan&quot;: 42');
});

test('answers are keyed by question text: a label, the labels joined in option order, or the typed Other text', () => {
  const toppings = { question: 'Which toppings?', header: 'Toppings', options: [{ label: 'Milk', description: '' }, { label: 'Sugar', description: '' }, { label: 'Honey', description: '' }], multiSelect: true };
  const none = { picked: [], other: false, text: '' };
  expect(answersFor([drink], [{ ...none, picked: ['Coffee'] }])).toEqual({ 'Do you prefer tea or coffee?': 'Coffee' });
  expect(answersFor([toppings], [{ ...none, picked: ['Honey', 'Milk'] }])).toEqual({ 'Which toppings?': 'Milk, Honey' });
  expect(answersFor([drink], [{ picked: [], other: true, text: '  Green tea ' }])).toEqual({ 'Do you prefer tea or coffee?': 'Green tea' });
  expect(answersFor([toppings], [{ picked: ['Sugar'], other: true, text: 'Cinnamon' }])).toEqual({ 'Which toppings?': 'Sugar, Cinnamon' });
  expect(answersFor([drink, toppings], [{ ...none, picked: ['Tea'] }, { ...none, picked: ['Milk'] }])).toEqual({ 'Do you prefer tea or coffee?': 'Tea', 'Which toppings?': 'Milk' });
});

test('answers stay null until every question has one', () => {
  const none = { picked: [], other: false, text: '' };
  expect(answersFor([drink], [none])).toBeNull();
  expect(answersFor([drink], [{ picked: [], other: true, text: '   ' }])).toBeNull();
  expect(answersFor([drink, drink], [{ ...none, picked: ['Tea'] }])).toBeNull();
  expect(answersFor([], [])).toBeNull();
});

test('the summary of a dialog is its first question, the plan note, or the tool name', () => {
  expect(dialogSummary({ tool: 'AskUserQuestion', input: { questions: [drink] } })).toBe('Do you prefer tea or coffee?');
  expect(dialogSummary({ tool: 'ExitPlanMode', input: { plan } })).toBe('Plan ready for your review');
  expect(dialogSummary({ tool: 'AskUserQuestion', input: { truncated: true, preview: '{' } })).toBe('AskUserQuestion');
  expect(dialogSummary({ tool: 'SomeFutureDialog', input: null })).toBe('SomeFutureDialog');
});
