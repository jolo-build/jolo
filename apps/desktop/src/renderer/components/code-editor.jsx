import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { Decoration, keymap } from '@codemirror/view';
import { defaultHighlightStyle, HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

// Loaded only when a file is shown as source, so CodeMirror and its languages stay out of the startup script.

/** The editor in the app's own colours, built once: the variables follow the light, dark, and named themes. Lines and
 * brackets light up only while the editor has focus, and fold chevrons only while the pointer is over the gutter. */
const theme = EditorView.theme({
  '&': { flex: '1', minHeight: '0', color: 'var(--text)', backgroundColor: 'transparent', fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 14px 0 4px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 12px' },
  '.cm-foldGutter span': { opacity: '0', transition: 'opacity .12s' },
  '.cm-gutters:hover .cm-foldGutter span, .cm-foldGutter span[title="Unfold line"]': { opacity: '1' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 60%, transparent)' },
  '&.cm-focused .cm-activeLineGutter': { color: 'var(--text)' },
  '.cm-line.file-source-location': { backgroundColor: 'color-mix(in srgb, var(--highlight) 16%, transparent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--highlight) 24%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--highlight) 12%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--highlight) 18%, transparent)', outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--red) 18%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 22%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--highlight) 30%, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted)' },
  '.cm-specialChar': { color: 'var(--red)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-textfield, .cm-button': { backgroundColor: 'var(--field)', backgroundImage: 'none', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--hover)', color: 'var(--text)' },
});

/** CodeMirror's highlighting tags live in @lezer/highlight, which the app does not depend on directly. The default
 * style holds every tag it colours together with that tag's parents, so the tags are found there by name. */
const known = new Map(defaultHighlightStyle.specs.flatMap(spec => [spec.tag].flat()).flatMap(tag => tag.set).map(tag => [String(tag), tag]));
/** @type {[string[], Record<string, string>][]} Each group of tags with its style; the colours are the app's syntax variables. */
export const SYNTAX = [
  [['keyword'], { color: 'var(--syntax-keyword)' }],
  [['string', 'special(string)', 'regexp', 'escape'], { color: 'var(--syntax-string)' }],
  [['literal', 'bool', 'atom'], { color: 'var(--syntax-number)' }], // numbers are literals
  [['comment', 'meta', 'contentSeparator'], { color: 'var(--syntax-comment)' }], // meta covers Markdown's # and * marks
  [['propertyName', 'definition(propertyName)'], { color: 'var(--syntax-variable)' }],
  [['typeName', 'className', 'namespace', 'macroName', 'definition(variableName)'], { color: 'var(--syntax-function)' }], // names where they are declared
  [['heading', 'strong'], { fontWeight: '600' }], [['emphasis'], { fontStyle: 'italic' }],
  [['link', 'url'], { textDecoration: 'underline' }], [['strikethrough'], { textDecoration: 'line-through' }],
  [['invalid'], { color: 'var(--red)' }],
];
export const highlightStyle = HighlightStyle.define(SYNTAX.map(([names, style]) => ({ tag: names.map(name => known.get(name)).filter(Boolean), ...style })).filter(spec => spec.tag.length));
const LOCATION = Decoration.line({ class: 'file-source-location' });
/** @param {number | null} line */
const locationAt = line => line ? EditorView.decorations.of(view => line <= view.state.doc.lines ? Decoration.set(LOCATION.range(view.state.doc.line(line).from)) : Decoration.none) : [];

/**
 * A file's text in CodeMirror: line numbers with folding, syntax colours for the file's language, and wrapped lines.
 * Read-only until `readOnly` is false; Cmd/Ctrl+S calls `onSave`. A `line` (and `column`) is scrolled to the middle and
 * marked, and scrolled to again whenever `reveal` changes, as when the same link is followed twice. The view is on the
 * element as `cmView`, so tests can read `cmView.state.doc`.
 * @param {{ path: string, value: string, readOnly?: boolean, onChange?: ((text: string) => void) | null, onSave?: (() => void) | null, line?: number | null, column?: number | null, reveal?: unknown }} props
 */
export function CodeEditor({ path, value, readOnly = true, onChange = null, onSave = null, line = null, column = null, reveal = null }) {
  const host = useRef(/** @type {HTMLDivElement | null} */ (null));
  const view = useRef(/** @type {EditorView | null} */ (null));
  const parts = useRef(/** @type {{ mode: Compartment, language: Compartment, location: Compartment } | null} */ (null));
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const syncing = useRef(false);
  const modeFor = (locked) => [EditorState.readOnly.of(locked), EditorView.editable.of(!locked), EditorView.contentAttributes.of(locked ? { tabindex: '0', 'aria-label': `Source of ${path}` } : { 'aria-label': `Edit ${path}` })];
  useEffect(() => {
    const mode = new Compartment(), language = new Compartment(), location = new Compartment();
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      basicSetup, EditorView.lineWrapping, theme, syntaxHighlighting(highlightStyle),
      Prec.high(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave?.(); return true; } }])),
      EditorView.updateListener.of(update => { if (update.docChanged && !syncing.current) handlers.current.onChange?.(update.state.doc.toString()); }),
      mode.of(modeFor(readOnly)), language.of([]), location.of([]),
    ] }) });
    view.current = editor; parts.current = { mode, language, location };
    /** @type {any} */ (host.current).cmView = editor;
    // A new face changes the text's metrics; CodeMirror measures again rather than keep the old line heights.
    const remeasure = () => editor.requestMeasure();
    window.addEventListener('jolo:fonts', remeasure);
    return () => { window.removeEventListener('jolo:fonts', remeasure); editor.destroy(); view.current = null; parts.current = null; };
  }, []);
  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.mode.reconfigure(modeFor(readOnly)) });
    if (!readOnly) view.current?.focus();
  }, [readOnly, path]);
  useEffect(() => {
    const description = LanguageDescription.matchFilename(languages, path.split('/').at(-1) ?? path);
    let current = true;
    view.current?.dispatch({ effects: parts.current.language.reconfigure([]) });
    description?.load().then(support => { if (current) view.current?.dispatch({ effects: parts.current.language.reconfigure(support) }); }, () => {});
    return () => { current = false; };
  }, [path]);
  // Text that changes from outside replaces the document, except while the user is typing in it; undo skips it.
  useEffect(() => {
    const editor = view.current;
    if (!editor || (editor.hasFocus && !readOnly) || editor.state.doc.toString() === value) return;
    syncing.current = true;
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) }); } finally { syncing.current = false; }
  }, [value]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const at = line && line <= editor.state.doc.lines ? editor.state.doc.line(line) : null;
    const position = at ? Math.min(at.to, at.from + Math.max(0, (column ?? 1) - 1)) : null;
    editor.dispatch({ effects: [parts.current.location.reconfigure(locationAt(line)), ...(at ? [EditorView.scrollIntoView(position, { y: 'center' })] : [])], ...(at ? { selection: { anchor: position } } : {}) });
  }, [line, column, reveal]);
  return <div ref={host} className="file-preview-source" />;
}
