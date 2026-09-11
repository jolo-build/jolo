import { EXIT } from './exit-codes.js';

export async function openAccountBrowser(url, { platform = process.platform, env = process.env } = {}) {
  if (env.SSH_CONNECTION || (platform !== 'darwin' && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return false;
  try {
    const proc = Bun.spawn(platform === 'darwin' ? ['open', url] : ['xdg-open', url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    return await proc.exited === 0;
  } catch { return false; }
}

/**
 * Run `jolo login`, `jolo logout` or `jolo whoami` against a connected engine.
 *
 * Everything after `client` exists so the tests can watch the command without a terminal, a
 * browser or a real clock. Nothing here reads what those collaborators return, so the types
 * promise only that something comes back.
 *
 * @param {{
 *   command: string,
 *   flags: Record<string, any>,
 *   client: { call: (method: string, params?: any) => Promise<any> },
 *   write?: (line: string) => unknown,
 *   openBrowser?: (url: string) => Promise<unknown>,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   signals?: { on: (signal: string, handler: () => void) => unknown, off: (signal: string, handler: () => void) => unknown },
 * }} options
 * @returns {Promise<number>} exit code
 */
export async function runAccountCommand({ command, flags, client, write = line => process.stdout.write(line + '\n'), openBrowser = openAccountBrowser, sleep = ms => Bun.sleep(ms), signals = process }) {
  if (command === 'whoami') {
    const status = await client.call('account.status', { refresh: true });
    write(flags.json ? JSON.stringify(status) : status.state === 'signed_in' ? `${status.account.name} <${status.account.email}>\n${status.origin}${status.note ? '\n' + status.note : ''}` : status.state === 'pending' ? `Sign-in pending. Code: ${status.pending.userCode}\n${status.pending.verificationUriComplete}` : 'Not signed in to Jolo.');
    return EXIT.completed;
  }
  if (command === 'logout') {
    const status = await client.call('account.logout', {});
    write(flags.json ? JSON.stringify(status) : status.note ?? 'Signed out of Jolo on this profile.');
    return EXIT.completed;
  }
  let status = await client.call('account.status', {});
  if (status.state === 'signed_in' && (!flags.tasks || status.device.scopes?.includes('tasks:read'))) {
    write(flags.json ? JSON.stringify({ type: 'account.signed_in', ...status }) : `Already signed in as ${status.account.email}. Run jolo logout to switch accounts.`);
    return EXIT.completed;
  }
  status = await client.call('account.login', { ...(flags.tasks ? { tasks: true } : {}), ...(flags.server ? { origin: flags.server } : {}), ...(flags['device-name'] ? { deviceName: flags['device-name'] } : {}) });
  write(flags.json ? JSON.stringify({ type: 'account.pending', ...status }) : `Open ${status.pending.verificationUriComplete}\n\nDevice code: ${status.pending.userCode}\nApprove only if the browser shows this same code.\nWaiting for sign-in… (Ctrl+C to cancel)`);
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', interrupt);
  try {
    if (!flags['no-open'] && !flags.json) await openBrowser(status.pending.verificationUriComplete);
    while (!interrupted && status.state === 'pending') {
      await sleep(1000);
      if (!interrupted) status = await client.call('account.status', {});
    }
    if (interrupted) {
      await client.call('account.cancel', {});
      write(flags.json ? JSON.stringify({ type: 'account.cancelled' }) : 'Sign-in cancelled.');
      return 130;
    }
    write(flags.json ? JSON.stringify({ type: `account.${status.state}`, ...status }) : status.state === 'signed_in' ? `Signed in as ${status.account.name} <${status.account.email}>.${status.source === 'session' ? '\nThe OS keychain is unavailable; this sign-in lasts only while the engine runs.' : ''}` : status.note ?? 'Sign-in did not complete.');
    return status.state === 'signed_in' ? EXIT.completed : EXIT.failed;
  } finally {
    signals.off('SIGINT', interrupt);
    signals.off('SIGTERM', interrupt);
  }
}
