import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, removeHome } from './helpers.js';
import { workingChanges, workingDiff } from '../../apps/engine/src/workspaces/working-changes.js';

const homes = [], engines = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const home of homes.splice(0)) removeHome(home);
});
const env = { git: Bun.which('git'), path: process.env.PATH };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };
function git(repo, ...args) {
  const result = Bun.spawnSync([env.git, ...args], { cwd: repo, env: gitEnv });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
function fixture({ committed = true, repository = true } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, 'repo'); mkdirSync(repo);
  writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  if (repository) {
    git(repo, 'init', '-q', '-b', 'main');
    if (committed) { git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'fixture'); }
  }
  return { home, repo, workspace: { path: repo } };
}

test('RPC discovers external edits and new files without file-tool events, including after session restore', async () => {
  const { home, repo } = fixture();
  const engine = await startEngine({ home }); engines.push(engine);
  const client = await engine.connect();
  const project = await client.call('project.open', { path: repo });
  const { session } = await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId });
  expect((await client.call('workspace.changes', { workspaceId: project.workspaceId })).files).toEqual([]);
  writeFileSync(path.join(repo, 'tracked.txt'), 'after\n');
  writeFileSync(path.join(repo, 'new file.txt'), 'new content\n');
  const first = await client.call('workspace.changes', { workspaceId: project.workspaceId });
  expect(first.source).toBe('git');
  expect(first.files.map(file => [file.path, file.op])).toEqual([['tracked.txt', 'replace'], ['new file.txt', 'create']]);
  expect((await client.call('workspace.diff', { workspaceId: project.workspaceId, path: 'tracked.txt' })).diff).toContain('+after');
  expect((await client.call('workspace.diff', { workspaceId: project.workspaceId, path: 'new file.txt' })).diff).toContain('+new content');
  await client.call('session.page', { sessionId: session.id });
  expect((await client.call('workspace.changes', { workspaceId: project.workspaceId })).files).toEqual(first.files);
  writeFileSync(path.join(repo, 'tracked.txt'), 'changed again\n');
  expect((await client.call('workspace.changes', { workspaceId: project.workspaceId })).files[0].revision).not.toBe(first.files[0].revision);
  client.close();
});

test('deletions, staged renames, and literal Git pathspec characters are reported', async () => {
  const { repo, workspace } = fixture();
  writeFileSync(path.join(repo, 'delete.txt'), 'gone\n');
  writeFileSync(path.join(repo, 'a[1].txt'), 'literal\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'more');
  git(repo, 'mv', 'tracked.txt', 'renamed file.txt');
  unlinkSync(path.join(repo, 'delete.txt'));
  writeFileSync(path.join(repo, 'a[1].txt'), 'literal edit\n');
  const files = (await workingChanges(workspace, env)).files;
  expect(files).toContainEqual(expect.objectContaining({ path: 'tracked.txt', newPath: 'renamed file.txt', op: 'rename' }));
  expect(files).toContainEqual(expect.objectContaining({ path: 'delete.txt', op: 'delete' }));
  expect((await workingDiff(workspace, env, 'delete.txt')).diff).toContain('-gone');
  expect((await workingDiff(workspace, env, 'a[1].txt')).diff).toContain('+literal edit');
});

test('repositories without a first commit show complete staged and unstaged additions', async () => {
  const { repo, workspace } = fixture({ committed: false });
  git(repo, 'add', '.');
  writeFileSync(path.join(repo, 'tracked.txt'), 'before\nafter staging\n');
  const result = (await workingDiff(workspace, env, 'tracked.txt'));
  expect(result.diff).toContain('+before');
  expect(result.diff).toContain('+after staging');
  expect((await workingChanges(workspace, env)).files[0].op).toBe('create');
});

test('nested workspaces report only their own paths', async () => {
  const { repo } = fixture();
  mkdirSync(path.join(repo, 'nested'));
  writeFileSync(path.join(repo, 'nested', 'new.txt'), 'nested\n');
  writeFileSync(path.join(repo, 'tracked.txt'), 'outside\n');
  const workspace = { path: path.join(repo, 'nested') };
  expect((await workingChanges(workspace, env)).files.map(file => file.path)).toEqual(['new.txt']);
  expect((await workingDiff(workspace, env, 'new.txt')).diff).toContain('+nested');
});

test('plain folders and missing Git are distinct from clean Git workspaces; errors are not empty success', async () => {
  const { workspace } = fixture({ repository: false });
  expect((await workingChanges(workspace, env))).toEqual({ source: 'none', files: [], truncated: false });
  expect((await workingChanges(workspace, { ...env, git: null })).source).toBe('none');
  await expect(workingChanges({ path: '/nonexistent-jolo-working-changes-fixture' }, env)).rejects.toThrow();
});

test('diffs cannot escape the workspace or read Git metadata', async () => {
  const { home, repo, workspace } = fixture();
  writeFileSync(path.join(home, 'private.txt'), 'outside\n');
  symlinkSync(home, path.join(repo, 'escape'));
  await expect(workingDiff(workspace, env, '../private.txt')).rejects.toThrow();
  await expect(workingDiff(workspace, env, '.git/config')).rejects.toThrow();
  await expect(workingDiff(workspace, env, 'escape/private.txt')).rejects.toThrow();
});
