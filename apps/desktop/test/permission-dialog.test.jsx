import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionDialog } from '../src/renderer/components/permission-dialog.jsx';
import { PermissionNotice } from '../src/renderer/components/permission-notice.jsx';

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

test('the notice of an inactive pane says approval is needed by default, or the title and icon it is given', () => {
  const approval = renderToStaticMarkup(<PermissionNotice request={{ summary: 'Execute command' }} active={false} onReview={() => {}} />);
  expect(approval).toContain('Approval needed');
  expect(approval).toContain('d="m12 3 8 3v6'); // shield
  expect(approval).toContain('aria-label="Review: Approval needed"');
  const question = renderToStaticMarkup(<PermissionNotice request={{ summary: 'Do you prefer tea or coffee?' }} title="Claude has a question" icon="chat" active={false} onReview={() => {}} />);
  expect(question).toContain('Claude has a question');
  expect(question).toContain('Do you prefer tea or coffee?');
  expect(question).toContain('d="M21 11.5'); // chat
  expect(question).toContain('aria-label="Review: Claude has a question"');
  expect(question).not.toContain('Approval needed');
  expect(question).not.toContain('permission request');
});
