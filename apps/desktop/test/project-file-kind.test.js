import { expect, test } from 'bun:test';
import { projectFileKind } from '../src/renderer/project-file-kind.js';

test('project file icons cover common IDE file families and special names', () => {
  expect(projectFileKind('src/app.tsx')).toEqual({ icon: 'fileCode', tone: 'react' });
  expect(projectFileKind('src/server.go')).toEqual({ icon: 'fileCode', tone: 'go' });
  expect(projectFileKind('package.json')).toEqual({ icon: 'package', tone: 'package' });
  expect(projectFileKind('README.md')).toEqual({ icon: 'fileText', tone: 'document' });
  expect(projectFileKind('.env.local')).toEqual({ icon: 'settings', tone: 'config' });
  expect(projectFileKind('assets/logo.svg')).toEqual({ icon: 'image', tone: 'image' });
  expect(projectFileKind('data.sqlite')).toEqual({ icon: 'database', tone: 'database' });
  expect(projectFileKind('bun.lock')).toEqual({ icon: 'lock', tone: 'muted' });
  expect(projectFileKind('unknown.binary')).toEqual({ icon: 'file', tone: 'muted' });
});
