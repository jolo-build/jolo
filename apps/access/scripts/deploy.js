import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const fields = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'RESEND_API_KEY'];

export function parseSecretJSON(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid credential JSON.'); }
}

export function validateSecrets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid deployment secret fields.');
  for (const key of fields) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 4096 || /\s/.test(value[key]))
      throw new Error(`Missing or invalid ${key}.`);
  }
  if (/^(gh[pousr]_|github_pat_)/.test(value.GITHUB_CLIENT_SECRET))
    throw new Error('Use the GitHub OAuth app Client Secret, not a personal access token.');
  if (!value.RESEND_API_KEY.startsWith('re_')) throw new Error('Invalid RESEND_API_KEY.');
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

export function parseOAuthFile(text) {
  if (text.trim().startsWith('{')) {
    try { return JSON.parse(text); } catch { throw new Error('OAuth file must contain valid JSON or NAME=value lines.'); }
  }
  const result = {};
  for (const line of text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))) {
    const match = /^\s*(GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('OAuth file needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, one NAME=value per line.');
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

export async function assertPrivateBucket(api) {
  const [managed, custom] = await Promise.all([api('/domains/managed'), api('/domains/custom')]);
  if (managed.enabled !== false || !Array.isArray(custom.domains) || custom.domains.length)
    throw new Error('Deployment secrets require a private R2 bucket with r2.dev disabled and no custom domains.');
}

export async function withSecretsFile(secrets, action) {
  const directory = mkdtempSync(join(tmpdir(), 'jolo-deploy-'));
  const path = join(directory, 'secrets.json');
  try {
    writeFileSync(path, JSON.stringify(validateSecrets(secrets)), { mode: 0o600 });
    return await action(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  const mode = process.argv[2] ?? 'deploy';
  if (!['deploy', 'store'].includes(mode)) throw new Error('Usage: deploy.js [deploy | store <oauth-file> <resend-file>]');
  const config = JSON.parse(readFileSync(join(root, 'deploy/access.wrangler.jsonc'), 'utf8'));
  const location = JSON.parse(readFileSync(join(root, 'deploy/access-secrets.json'), 'utf8'));
  const hidden = [];
  const run = (args, silent = false) => {
    const result = spawnSync('node', [wrangler, ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log', CI: 'true' },
    });
    // Auth output and provider error bodies must never reach deployment logs.
    if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed. Check Cloudflare login, permissions, and configuration.`);
    if (!silent && result.stdout) console.log(hidden.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), result.stdout).trim());
    return result.stdout;
  };
  const local = mode === 'store' ? validateSecrets({
    ...parseOAuthFile(readFileSync(process.argv[3], 'utf8')),
    RESEND_API_KEY: readFileSync(process.argv[4], 'utf8').trim(),
  }) : null;
  if (local) hidden.push(...Object.values(local));
  run(['whoami'], true); // Refresh the saved OAuth session when necessary.
  const auth = parseSecretJSON(run(['auth', 'token', '--json'], true));
  if (!auth.token) throw new Error('Use wrangler login or CLOUDFLARE_API_TOKEN.');
  hidden.push(auth.token);
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}/r2/buckets/${encodeURIComponent(location.bucket)}`;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, {
      ...options, headers: { Authorization: `Bearer ${auth.token}`, ...options.headers },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`R2 request failed (HTTP ${response.status}).`);
    return response;
  };
  await assertPrivateBucket(async path => {
    const body = await (await request(path)).json();
    if (!body.success) throw new Error('Unable to verify R2 bucket privacy.');
    return body.result;
  });
  const object = `/objects/${encodeURIComponent(location.key)}`;
  if (local) {
    await request(object, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(local) });
    const stored = validateSecrets(parseSecretJSON(await (await request(object)).text()));
    if (fields.some(key => stored[key] !== local[key])) throw new Error('R2 credential verification failed.');
    console.log(`Stored and verified ${fields.join(', ')} in private R2 storage.`);
    return;
  }
  const secrets = validateSecrets(parseSecretJSON(await (await request(object)).text()));
  hidden.push(...Object.values(secrets));
  const database = config.d1_databases.find(value => value.binding === 'ACCESS_DB');
  if (!database || database.database_id === '00000000-0000-0000-0000-000000000000') throw new Error('Configure the production D1 database before deploying.');
  const args = ['--config', 'deploy/access.wrangler.jsonc', '--env', ''];
  run(['d1', 'migrations', 'apply', 'ACCESS_DB', '--remote', ...args]);
  await withSecretsFile(secrets, path => run(['deploy', ...args, '--secrets-file', path]));
  console.log('Deployed Jolo Access using credentials loaded from private R2 storage.');
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
