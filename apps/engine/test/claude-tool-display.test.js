// The line a Claude Code tool call shows in the transcript: the tool and the one argument that tells what it does, as
// Claude Code shows it (`Read connectors.md`, the command's description), the raw input only where nothing tells more.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOOL_DISPLAY_MAX_BYTES } from '../src/agents/hosted.js';
import { toolDisplay } from '../src/agents/claude-stream.js';

const cwd = '/work/repo';
const home = '/Users/me';
const show = (name, input) => toolDisplay(name, input, { cwd, home });

test('a file tool names its file, relative to the working directory when under it, else from home or as given', () => {
  expect(show('Read', { file_path: '/work/repo/src/a.js' })).toBe('Read src/a.js');
  expect(show('Read', { file_path: '/etc/hosts' })).toBe('Read /etc/hosts');
  expect(show('Read', { file_path: '/Users/me/notes/todo.md' })).toBe('Read ~/notes/todo.md');
  expect(show('Read', { file_path: '/work/repository/x.js' })).toBe('Read /work/repository/x.js'); // a sibling, not under it
  expect(show('Read', { file_path: 'src/a.js' })).toBe('Read src/a.js'); // relative already
  // The lines read, when the call names them (offset is the first line, limit how many).
  expect(show('Read', { file_path: '/work/repo/src/a.js', offset: 120, limit: 81 })).toBe('Read src/a.js (lines 120–200)');
  expect(show('Read', { file_path: '/work/repo/src/a.js', offset: 120 })).toBe('Read src/a.js (from line 120)');
  expect(show('Read', { file_path: '/work/repo/src/a.js', limit: 50 })).toBe('Read src/a.js (lines 1–50)');
  expect(show('Edit', { file_path: '/work/repo/src/a.js', old_string: 'a', new_string: 'b' })).toBe('Edit src/a.js');
  expect(show('MultiEdit', { file_path: '/work/repo/src/a.js', edits: [] })).toBe('Edit src/a.js');
  expect(show('NotebookEdit', { notebook_path: '/work/repo/n.ipynb', new_source: 'x' })).toBe('Edit n.ipynb');
  expect(show('Write', { file_path: '/work/repo/src/new.js', content: 'x' })).toBe('Write src/new.js');
  expect(show('LS', { path: '/work/repo/src' })).toBe('List src');
  expect(show('LS', { path: '/work/repo' })).toBe('List .');
  // A path is resolved before it is placed: one that only looks under the working directory is shown in full.
  expect(show('Read', { file_path: '/work/repo/../other/x.js' })).toBe('Read /work/other/x.js');
  expect(show('Read', { file_path: '/work/repo/src/../a.js' })).toBe('Read a.js');
  expect(show('LS', { path: '/work/repo/src/..' })).toBe('List .');
  expect(show('LS', { path: '/work/repo/' })).toBe('List .');
  // Either spelling of the working directory, as given and as resolved, counts.
  expect(toolDisplay('Read', { file_path: '/private/work/repo/a.js' }, { cwd: ['/work/repo', '/private/work/repo'], home })).toBe('Read a.js');
});

test('a file named through a link to the working directory is shown from it too', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tool-display-')));
  try {
    mkdirSync(path.join(dir, 'real', 'repo', 'src'), { recursive: true });
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    const shown = (file) => toolDisplay('Write', { file_path: file, content: '' }, { cwd: path.join(dir, 'real', 'repo'), home });
    expect(shown(path.join(dir, 'link', 'repo', 'src', 'new.js'))).toBe('Write src/new.js'); // not there yet: its folder is
    expect(shown(path.join(dir, 'link', 'elsewhere', 'x.js'))).toBe(`Write ${path.join(dir, 'link', 'elsewhere', 'x.js')}`); // no such folder: as given
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a command shows its description, else its first line, and the whole command on the line below, for when it is opened', () => {
  expect(show('Bash', { command: 'ls -la', description: 'List the files' })).toBe('Bash: List the files\n$ ls -la');
  expect(show('Bash', { command: 'git status' })).toBe('Bash: git status\n$ git status');
  // A command's further lines are marked as its own, so none of them can be read as its output.
  expect(show('Bash', { command: 'cd app\nbun test' })).toBe('Bash: cd app\n$ cd app\n> bun test');
  expect(show('Bash', { command: '\n  make\nmake test', description: 'Build' })).toBe('Bash: Build\n$ \n>   make\n> make test');
  expect(show('Bash', { command: 'ls', description: 7 })).toBe('Bash: ls\n$ ls'); // a description that is not text
  expect(show('Bash', { command: 'ls', description: 'Two\nlines' })).toBe('Bash: Two lines\n$ ls'); // the head stays one line
});

test('a search names what it looks for and where; a fetch its address; the todo list and a skill their kind, with their input below', () => {
  expect(show('Grep', { pattern: 'integration', path: '/work/repo/docs' })).toBe('Search "integration" in docs');
  expect(show('Grep', { pattern: 'integration' })).toBe('Search "integration"');
  expect(show('Grep', { pattern: 'x', path: '/opt/lib' })).toBe('Search "x" in /opt/lib');
  expect(show('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts');
  expect(show('Glob', { pattern: '**/*.ts', path: '/work/repo/src' })).toBe('Glob **/*.ts in src');
  expect(show('WebFetch', { url: 'https://example.com/a', prompt: 'summarise' })).toBe('Fetch https://example.com/a');
  expect(show('WebSearch', { query: 'bun sqlite' })).toBe('Web search "bun sqlite"');
  const todos = { todos: [{ content: 'Write tests', status: 'pending' }] };
  expect(show('TodoWrite', todos)).toBe(`Todo list\n${JSON.stringify(todos)}`);
  expect(show('Skill', { skill: 'review', args: 'src' })).toBe('Skill review\n{"skill":"review","args":"src"}');
});

test('a field missing or not text, and any other tool, keep the raw head; a subagent, a workflow and Jolo\'s own tools are as before', () => {
  expect(show('Read', {})).toBe('Read {}');
  // A value that is only blank is missing too.
  expect(show('Bash', { command: '  \n ' })).toBe('Bash {"command":"  \\n "}');
  expect(show('Read', { file_path: '   ' })).toBe('Read {"file_path":"   "}');
  expect(show('Bash', { command: 'ls', description: '   ' })).toBe('Bash: ls\n$ ls'); // a blank description: the command's line
  expect(show('Read', { file_path: 42 })).toBe('Read {"file_path":42}');
  expect(show('Bash', { command: ['ls'] })).toBe('Bash {"command":["ls"]}');
  expect(show('Grep', { pattern: null, path: 'src' })).toBe('Grep {"pattern":null,"path":"src"}');
  expect(show('Skill', {})).toBe('Skill {}');
  expect(show('Bash', undefined)).toBe('Bash {}');
  expect(show('mcp__probe__ping', { a: 1 })).toBe('mcp__probe__ping {"a":1}');
  // Byte for byte as before: the desktop reads these heads back (parseSubagent, parseDelegationCall, parseWorkflowCall).
  const agent = { subagent_type: 'Explore', description: 'Find it', model: 'haiku', prompt: 'Look', extra: true };
  expect(show('Agent', agent)).toBe('Agent {"subagent_type":"Explore","description":"Find it","model":"haiku","prompt":"Look"}');
  expect(show('Task', agent)).toBe('Task {"subagent_type":"Explore","description":"Find it","model":"haiku","prompt":"Look"}');
  const workflow = { script: 'export const meta = { name: "demo" }' };
  expect(show('Workflow', workflow)).toBe(`Workflow ${JSON.stringify(workflow)}`);
  for (const name of ['mcp__jolo__delegate_task', 'mcp__jolo__delegation_status', 'mcp__jolo__delegation_cancel']) {
    expect(show(name, { title: 'x', prompt: 'y' })).toBe(`${name} {"title":"x","prompt":"y"}`);
  }
});

test('a head\'s value is cut to 160 characters, and the whole line stays within the display bound', () => {
  const long = 'd'.repeat(300);
  expect(show('Bash', { command: 'ls', description: long }).split('\n')[0]).toBe(`Bash: ${'d'.repeat(159)}…`);
  // By characters, never splitting one written as two code units.
  expect(show('Bash', { command: 'ls', description: '😀'.repeat(200) }).split('\n')[0]).toBe(`Bash: ${'😀'.repeat(159)}…`);
  // A long path keeps its file's name, cut in the middle instead.
  expect(show('Read', { file_path: `/work/repo/src/${long}/name.js` })).toBe(`Read src/${'d'.repeat(147)}…/name.js`);
  expect(show('Read', { file_path: `/work/repo/${long}` })).toBe(`Read …${'d'.repeat(159)}`); // a name alone too long: its end
  expect(show('Grep', { pattern: 'x', path: `/work/repo/${long}/docs` })).toBe(`Search "x" in ${'d'.repeat(154)}…/docs`);
  const huge = show('Bash', { command: `echo ${'é'.repeat(10_000)}` });
  expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(TOOL_DISPLAY_MAX_BYTES - 1); // the newline the turn adds still fits
  expect(huge.startsWith(`Bash: echo ${'é'.repeat(154)}…\n$ echo é`)).toBe(true);
});

test("Claude's task list tools only touch that list, so they are read class and never ask", async () => {
  const { classify } = await import("../src/agents/claude-stream.js");
  for (const tool of ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite"]) expect(classify(tool)).toBe("read");
  expect(classify("Bash")).toBe("process");
});

test("a task call's line keeps only what the pinned list reads, each text cut, so a long description never cuts its JSON", async () => {
  const { toolDisplay } = await import("../src/agents/claude-stream.js");
  const made = toolDisplay("TaskCreate", { subject: "Read config", description: "d".repeat(10_000), activeForm: "Reading config" });
  expect(made).toBe('TaskCreate {"subject":"Read config","activeForm":"Reading config"}');
  const changed = toolDisplay("TaskUpdate", { taskId: "2", status: "completed", description: "d".repeat(10_000), subject: "s".repeat(1000) });
  expect(JSON.parse(changed.slice("TaskUpdate ".length))).toEqual({ taskId: "2", status: "completed", subject: "s".repeat(300) });
});

test("a long TodoWrite list keeps its JSON whole: each item's text cut, and its in-progress wording dropped when it would not fit", async () => {
  const { toolDisplay } = await import("../src/agents/claude-stream.js");
  const todos = Array.from({ length: 12 }, (_, at) => ({ content: `Item ${at} ${'c'.repeat(300)}`, status: at < 3 ? 'completed' : 'pending', activeForm: `Doing ${at} ${'a'.repeat(300)}` }));
  const shown = toolDisplay("TodoWrite", { todos });
  const [head, below] = [shown.slice(0, shown.indexOf('\n')), shown.slice(shown.indexOf('\n') + 1)];
  expect(head).toBe("Todo list");
  const parsed = JSON.parse(below);
  expect(parsed.todos).toHaveLength(12);
  expect(parsed.todos[0].content).toHaveLength(200);
  expect(parsed.todos[0].activeForm).toBeUndefined();
  const short = JSON.parse(toolDisplay("TodoWrite", { todos: [{ content: 'Plan', status: 'pending', activeForm: 'Planning' }] }).split('\n')[1]);
  expect(short.todos[0]).toEqual({ content: 'Plan', status: 'pending', activeForm: 'Planning' });
});
