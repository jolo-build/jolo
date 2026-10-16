import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileApplicationChoices, fileApplicationAction, launchFileApplication, githubFileUrl } from '../src/main/file-apps.js';

test('file-specific applications include icons; actions validate choices and preserve file bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-file-apps-'));
  try {
    const target = path.join(root, 'source%20 $(literal).ts');
    await writeFile(target, 'const value = 1;');
    const resolved = await realpath(target);
    const call = async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [{ id: 'w', path: root, present: true }] };
    const record = { launched: [], revealed: [], urls: [] };
    const services = {
      platform: /** @type {const} */ ('darwin'), window: {},
      app: { getFileIcon: async () => ({ resize: () => ({ toDataURL: () => 'data:image/png;base64,aW1hZ2U=' }) }) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/Applications/Zed.app'] }), showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'saved.ts') }) },
      shell: { showItemInFolder: file => record.revealed.push(file), openExternal: async url => { record.urls.push(url); } },
      list: async file => { expect(file).toBe(resolved); return [{ name: 'Visual Studio Code.app', path: '/Applications/Visual Studio Code.app', preferred: true }]; },
      launch: async (...args) => { record.launched.push(args); },
      github: async () => 'https://github.com/jolo/test/blob/abc/source.ts',
    };
    const params = { sessionId: 's', path: target, nativePath: true };
    const choices = await fileApplicationChoices(call, services, params);
    expect(choices.apps[0]).toMatchObject({ name: 'Visual Studio Code', icon: 'data:image/png;base64,aW1hZ2U=', preferred: true });
    expect(choices.canChoose).toBe(true);
    await fileApplicationAction(call, services, { ...params, action: 'application', application: '/Applications/Visual Studio Code.app' });
    expect(record.launched).toEqual([[resolved, '/Applications/Visual Studio Code.app']]);
    await expect(fileApplicationAction(call, services, { ...params, action: 'application', application: '/Applications/Unknown.app' })).rejects.toThrow('no longer available');
    await fileApplicationAction(call, services, { ...params, action: 'choose' });
    expect(record.launched.at(-1)).toEqual([resolved, '/Applications/Zed.app']);
    services.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    await fileApplicationAction(call, services, { ...params, action: 'choose' }); expect(record.launched).toHaveLength(2);
    await fileApplicationAction(call, services, { ...params, action: 'reveal' }); expect(record.revealed).toEqual([resolved]);
    await fileApplicationAction(call, services, { ...params, action: 'github' }); expect(record.urls).toEqual([choices.githubUrl]);
    await fileApplicationAction(call, services, { ...params, action: 'save' }); expect(await readFile(path.join(root, 'saved.ts'), 'utf8')).toBe('const value = 1;');
    services.list = async () => { throw new Error('Unavailable'); };
    expect(await fileApplicationChoices(call, services, params)).toMatchObject({ canChoose: true, error: 'Could not load installed apps.' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitHub links use tracked file, origin repository and immutable revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jolo-github-file-'));
  const git = args => { const result = Bun.spawnSync(['git', ...args], { cwd: root }); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  try {
    await writeFile(path.join(root, 'my file.ts'), 'value');
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']); git(['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    expect(await githubFileUrl(path.join(root, 'my file.ts'))).toBe(`https://github.com/owner/repo/blob/${git(['rev-parse', 'HEAD'])}/my%20file.ts`);
    await writeFile(path.join(root, 'new.ts'), 'new'); expect(await githubFileUrl(path.join(root, 'new.ts'))).toBeNull();
    git(['add', 'new.ts']); expect(await githubFileUrl(path.join(root, 'new.ts'))).toBeNull();
    git(['remote', 'set-url', 'origin', 'https://github.com.evil.test/owner/repo.git']); expect(await githubFileUrl(path.join(root, 'my file.ts'))).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('application launcher rejects commands and ordinary files as applications', async () => {
  await expect(launchFileApplication('/tmp/example.txt', '/bin/sh')).rejects.toThrow('Choose a macOS application');
  await expect(launchFileApplication('/tmp/example.txt', 'TextEdit.app')).rejects.toThrow('Choose a macOS application');
});
