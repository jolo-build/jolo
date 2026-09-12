export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeHTML;

export function layout(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="light dark"><title>${e(title)} · Jolo</title><link rel="icon" type="image/png" href="/assets/favicon.png"><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><link rel="preload" href="/assets/inter.woff2" as="font" type="font/woff2" crossorigin><script src="/theme.js"></script><script src="/assets/task-markdown.js" defer></script><link rel="stylesheet" href="/styles.css"></head><body>
  <header><a class="brand" href="https://jolo.build" aria-label="Jolo home"><span>jolo</span></a><span class="service">/ &nbsp; Access</span><label class="theme-switch" hidden>Theme<select id="color-theme" aria-label="Color theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></header>
  <main id="main">${content}</main><footer><span>Your agents. Your workspace.</span><a href="https://jolo.build">Back to Jolo</a></footer></body></html>`;
}

// All Access pages share one viewport shell; public pages offer sign-in and device entry.
export function appPage(title, body, { kind = '', active = '', publicPage = false } = {}) {
  const links = publicPage ? [['/', 'Sign in', 'signin'], ['/device', 'Connect a device', 'device']] : [['/tasks', 'Tasks', 'tasks'], ['/teams', 'Teams', 'teams'], ['/labels', 'Labels', 'labels'], ['/account', 'Account', 'account']];
  const nav = `<nav class="task-nav" aria-label="${publicPage ? 'Access' : 'Account'} navigation">${links.map(([href, label, key]) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  return layout(title, `<section class="task-app">${nav}<div class="task-content ${e(kind)}">${body}</div></section>`);
}

const heading = (title, description = '', action = '') => `<div class="task-heading"><div><p class="eyebrow">JOLO ACCOUNT</p><h1>${e(title)}</h1>${description ? `<p class="fine">${e(description)}</p>` : ''}</div>${action}</div>`;
const csrf = account => `<input type="hidden" name="csrf" value="${e(account.csrf)}">`;

/**
 * The sign-in page renders before the service is fully configured, so `providers` is empty until
 * credentials exist for a provider. `error` is the reason code a failed callback redirected with,
 * which is a query parameter rather than a flag, and is absent on a first visit.
 * @param {{ providers?: { github?: boolean, google?: boolean }, error?: string | boolean | null, userCode?: string | null }} options
 */
export function signInPage({ providers = {}, error = false, userCode = null }) {
  const query = userCode ? `?user_code=${encodeURIComponent(userCode)}` : '';
  return appPage('Sign in', `${heading('Welcome to Jolo.', 'Sign in to manage your identity, tasks, and teams.')}
    <div class="access-grid access-two-column">
      <section class="access-panel" aria-labelledby="signin-title"><div class="access-panel-body"><h2 id="signin-title">Sign in to your account</h2><p>${userCode ? 'Sign in to review your device connection.' : 'Choose an account to continue.'}</p>
        ${error ? `<p class="notice" role="alert">${error === 'email' ? 'Your account needs a verified email to sign in. Verify it with your sign-in provider, then try again. GitHub requires a verified primary email.' : 'We couldn’t complete sign-in. Please start again. If this keeps happening, contact the service administrator.'}</p>` : ''}
        <div class="signin-providers">${providers.google ? `<a class="button secondary" href="/login/google${query}">Continue with Google <span aria-hidden="true">↗</span></a>` : ''}
        ${providers.github ? `<a class="button secondary" href="/login${query}">Continue with GitHub <span aria-hidden="true">↗</span></a>` : ''}</div>
        ${!providers.google && !providers.github ? '<p class="notice" role="status">Sign-in is not available yet. Please check back soon.</p>' : ''}
        <p class="fine">We request only your profile and verified email. Use the same sign-in provider each time to access your tasks and teams.</p>
      </div></section>
      <section class="access-panel" aria-labelledby="workspace-title"><div class="access-panel-body"><h2 id="workspace-title">Your account, across Jolo</h2><p>Manage tasks and teams here. Connect your desktop app or CLI to use your account in Jolo.</p><p class="fine">The Jolo desktop and CLI can still be used without an account.</p></div><div class="access-panel-actions"><a class="button secondary" href="/device">Connect a device</a></div></section>
    </div>`, { kind: 'access-page signin-page', active: 'signin', publicPage: true });
}

export function accountPage(account) {
  return appPage('Your account', `${heading('Account', `Welcome, ${account.name}.`)}
    <div class="access-grid account-grid">
      <section class="access-panel" aria-labelledby="account-title"><div class="access-panel-body"><h2 id="account-title">Account details</h2><dl class="account-details"><div><dt>Name</dt><dd>${e(account.name)}</dd></div><div><dt>Email</dt><dd>${e(account.email)}</dd></div><div><dt>Connected through</dt><dd>${account.provider === 'google' ? 'Google' : 'GitHub'}</dd></div></dl></div></section>
      <section class="access-panel" aria-labelledby="devices-title"><div class="access-panel-body"><h2 id="devices-title">Connected devices</h2><p>Review desktop and CLI connections, manage access, or sign out a device.</p></div><div class="access-panel-actions"><a class="button secondary" href="/devices">Manage devices</a><a href="/device">Connect a device</a></div></section>
      <section class="access-panel" aria-labelledby="session-title"><div class="access-panel-body"><h2 id="session-title">Browser session</h2><p>Signing out here ends this browser session. Connected devices stay signed in.</p></div><form class="access-panel-actions" method="post" action="/logout">${csrf(account)}<button class="button secondary" type="submit">Sign out</button></form></section>
    </div>`, { kind: 'access-page', active: 'account' });
}

export function deviceEntryPage(error = false, signedIn = false) {
  return appPage('Connect a device', `${heading('Connect Jolo.', 'Connect your desktop app or CLI to your account.')}
    <div class="access-grid access-two-column">
      <section class="access-panel" aria-labelledby="code-title"><div class="access-panel-body"><h2 id="code-title">Enter your device code</h2><p>Enter the code shown in your desktop app or terminal.</p>${error ? '<p class="notice" role="alert">This code is invalid, expired, or already used. Start sign-in again in Jolo.</p>' : ''}<form method="get" action="/device"><label>Device code<input class="text-input" name="user_code" required maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH"></label><button class="button" type="submit">Continue</button></form></div></section>
      <section class="access-panel" aria-labelledby="get-code-title"><div class="access-panel-body"><h2 id="get-code-title">Get a code from Jolo</h2><p>Start sign-in in Jolo desktop or run <code>jolo login</code> in your terminal.</p><p class="fine">You’ll review the device and its requested access before approving the connection.</p></div></section>
    </div>`, { kind: 'access-page', active: signedIn ? 'account' : 'device', publicPage: !signedIn });
}

export function deviceApprovalPage(account, flow) {
  return appPage('Approve device', `${heading('Approve device', 'Review this connection before continuing.')}
    <form class="device-approval-form" method="post" action="/device/approve">${csrf(account)}<input type="hidden" name="user_code" value="${e(flow.user_code)}">
      <div class="access-grid access-two-column approval-details task-scroll" tabindex="0" aria-label="Device and requested access">
        <section class="access-panel" aria-labelledby="verify-title"><div class="access-panel-body"><h2 id="verify-title">Is this your Jolo?</h2><p>Only approve a sign-in you started. Make sure this code matches the code in your app or terminal.</p><p class="device-code">${e(flow.user_code)}</p><dl class="account-details"><div><dt>Device</dt><dd>${e(flow.name)}</dd></div><div><dt>Requesting address</dt><dd>${e(flow.address)}</dd></div></dl></div></section>
        <section class="access-panel" aria-labelledby="permissions-title"><div class="access-panel-body"><h2 id="permissions-title">Requested access</h2><dl class="account-details"><div><dt>Account</dt><dd>${e(account.email)}</dd></div><div><dt>Permissions</dt><dd>${flow.scope?.split(' ').includes('tasks:read') ? 'Identity and task access' : 'Identity only'}</dd></div></dl><p class="fine">This connects your Jolo account. It grants no access to files or agent tools.</p>${flow.scope?.split(' ').includes('tasks:read') ? '<p class="notice">Task access: this Jolo profile can read tasks you have permission to view and send referenced task descriptions to your selected coding agent.</p>' : ''}</div></section>
      </div>
      <div class="task-actions"><button class="button" type="submit" name="decision" value="approved">Approve device</button><button class="button secondary" type="submit" name="decision" value="denied">Decline</button></div>
    </form>`, { kind: 'access-page approval-page', active: 'account' });
}

export function deviceResultPage(approved) {
  return appPage(approved ? 'Device approved' : 'Sign-in declined', `${heading(approved ? 'Device approved.' : 'Sign-in declined.')}
    <section class="access-panel access-message"><div class="access-panel-body"><h2>${approved ? 'Return to Jolo' : 'Connection declined'}</h2><p>${approved ? 'Return to Jolo to finish connecting your account. You can close this page.' : 'This device will not be connected to your account.'}</p></div><div class="access-panel-actions"><a class="button secondary" href="/devices">Connected devices</a><a href="/account">Back to account</a></div></section>`, { kind: 'access-page', active: 'account' });
}

export function devicesPage(account, devices) {
  return appPage('Connected devices', `${heading('Connected devices', 'Manage where you’re signed in to Jolo.', '<a class="button secondary" href="/device">Connect a device</a>')}
    <p class="device-account"><a href="/account">Account</a><span>${e(account.email)}</span></p>
    <div class="device-list task-scroll" tabindex="0" aria-label="Connected devices">${devices.length ? devices.map(device => `<article class="device-row"><div class="device-row-main"><h2>${e(device.name)}</h2><p class="fine">Connected ${e(new Date(device.created_at).toISOString().slice(0, 10))} · expires ${e(new Date(device.expires_at).toISOString().slice(0, 10))}</p><span class="task-label">${device.scope?.split(' ').includes('tasks:read') ? 'Identity and task access' : 'Identity only'}</span></div><form method="post" action="/devices/revoke">${csrf(account)}<input type="hidden" name="device_id" value="${e(device.id)}"><button class="button secondary" type="submit">Sign out device</button></form></article>`).join('') : '<p class="task-empty">No devices connected yet. Sign in from Jolo desktop or run <code>jolo login</code> in your terminal.</p>'}</div>`, { kind: 'devices-page', active: 'account' });
}

export function errorPage(status) {
  const missing = status === 404;
  return appPage(missing ? 'Page not found' : 'Unable to continue', `${heading(missing ? 'Page not found.' : 'Unable to continue.')}
    <section class="access-panel access-message"><div class="access-panel-body"><p class="eyebrow">${e(status)}</p><p>${missing ? 'This page is not available.' : status === 429 ? 'Too many sign-in attempts. Please wait a minute and try again.' : 'Please return to sign-in and try again.'}</p><a class="button" href="/">Return to sign-in</a></div></section>`, { kind: 'access-page', publicPage: true });
}
