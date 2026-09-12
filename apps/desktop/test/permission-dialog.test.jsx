import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionDialog } from '../src/renderer/components/permission-dialog.jsx';

const render = request => renderToStaticMarkup(<PermissionDialog request={request} workspacePath="/work/my project" onDecide={async () => {}} />);

test('title-only tool approvals show the action and resolve legacy dot directories', () => {
  const html = render({ cwd: '.', script: '', summary: 'Devin CLI: Inspect browser tools', tool: 'devin:execute' });
  expect(html).toContain('Allow this action?');
  expect(html).toContain('Devin CLI: Inspect browser tools');
  expect(html).toContain('Runs in: /work/my project');
  expect(html).not.toContain('Run this command?');
});

test('command approvals retain the command and explicit execution directory', () => {
  const html = render({ cwd: '/work/my project/subfolder', script: 'echo tool-details', summary: 'Execute command' });
  expect(html).toContain('Run this command?');
  expect(html).toContain('echo tool-details');
  expect(html).toContain('Runs in: /work/my project/subfolder');
});
