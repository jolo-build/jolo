import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPanel } from './account-settings.jsx';

const initial = { state: 'signed_out', origin: 'https://access.jolo.build', account: null, device: null, pending: null, source: 'none', note: null };
const render = account => renderToStaticMarkup(<AccountPanel account={account} connected server={initial.origin} />);

test('desktop account section keeps local use available and shows pending approval code', () => {
  expect(render(initial)).toContain('works locally without signing in');
  const pending = render({ ...initial, state: 'pending', pending: { userCode: 'ABCD-EFGH', verificationUriComplete: initial.origin + '/device?user_code=ABCD-EFGH' } });
  expect(pending).toContain('ABCD-EFGH'); expect(pending).toContain('Open sign-in page'); expect(pending).toContain('Cancel sign-in');
});

test('desktop shows account details, session-only storage, and device management', () => {
  const html = render({ ...initial, state: 'signed_in', account: { name: '<Developer>', email: 'dev@example.com' }, device: { name: 'My laptop' }, source: 'session' });
  expect(html).toContain('&lt;Developer&gt;'); expect(html).toContain('dev@example.com'); expect(html).toContain('My laptop');
  expect(html).toContain('OS keychain is unavailable'); expect(html).toContain('Manage devices'); expect(html).toContain('Sign out');
});

test('task approval is explicit and pending upgrades keep the approval screen visible',()=>{
  const signedIn={...initial,state:'signed_in',account:{name:'Developer',email:'dev@example.com'},device:{name:'Laptop',scopes:['account:read']}};
  expect(render(signedIn)).toContain('Connect tasks');
  expect(render({...signedIn,device:{...signedIn.device,scopes:['account:read','tasks:read']}})).toContain('Open tasks');
  const upgrading=render({...signedIn,state:'pending',pending:{userCode:'ABCD-EFGH'}});
  expect(upgrading).toContain('Approve this device'); expect(upgrading).toContain('Cancel sign-in');
});
