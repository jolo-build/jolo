// Exercise a real release with no development runtime on PATH and isolated user data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startSmokeModel, SMOKE_MODEL_KEY } from '../tests/fixtures/smoke-model.js';

const root = path.resolve(import.meta.dir, '..');
const [flag, value, ...extra] = process.argv.slice(2);
if ((flag && !['--origin', '--dist'].includes(flag)) || (flag && !value) || extra.length || (flag === '--origin' && !/^https:\/\/[A-Za-z0-9.-]+$/.test(value))) throw new Error('Usage: bun scripts/smoke-install.js [--origin https://HOST | --dist BUILD_DIR]');
const remoteOrigin = flag === '--origin' ? value : null;
const buildDirectory = flag === '--dist' ? path.resolve(value) : null;
const temporary = await mkdtemp('/tmp/jolo-install-smoke-');
const prefix = path.join(temporary, 'install prefix');
const home = path.join(temporary, 'home');
const project = path.join(temporary, 'project');
const executable = path.join(prefix, 'bin/jolo');
const environment = { ...process.env, PATH: '/usr/bin:/bin', JOLO_IDLE_MS: '1500', OPENAI_API_KEY: SMOKE_MODEL_KEY, JOLO_CREDENTIALS: 'session' };
let server;
const modelServer = startSmokeModel();

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env] the child's whole environment, not additions to
 *   it: the installer runs with development tooling off PATH, and some steps add a variable or two.
 */
async function run(args, env = environment) {
  const child = Bun.spawn(args, { cwd: temporary, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `${args[0]} failed:\n${stderr}\n${stdout}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

try {
  if (!remoteOrigin) {
    const publicRoot = path.join(root, 'apps/website/dist');
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (buildDirectory) {
        const manifest = JSON.parse(await readFile(path.join(buildDirectory, 'manifest.json'), 'utf8'));
        if (pathname === '/install.sh') return new Response(Bun.file(path.join(root, 'scripts/install.sh')));
        if (pathname === '/releases/latest.txt') return new Response(`${manifest.version}\n`);
        const prefix = `/releases/${manifest.version}/`;
        const name = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
        if (![manifest.archive.name, `${manifest.archive.name}.sha256`].includes(name)) return new Response('Not found', { status: 404 });
        return new Response(Bun.file(path.join(buildDirectory, name)));
      }
      if (pathname !== '/install.sh' && !/^\/releases\/[A-Za-z0-9./_-]+$/.test(pathname)) return new Response('Not found', { status: 404 });
      const file = Bun.file(path.join(publicRoot, pathname));
      return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
    } });
  }
  const origin = remoteOrigin ?? `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${origin}/install.sh`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  const script = await response.text();
  assert.equal(script, await readFile(path.join(root, 'scripts/install.sh'), 'utf8'), 'Served installer differs from source.');
  const installer = path.join(temporary, 'install.sh');
  await writeFile(installer, script);
  console.log(await run(['/bin/bash', installer, '--prefix', prefix], { ...environment, JOLO_INSTALL_BASE_URL: origin }));
  assert.match(await run([executable, '--version']), /^jolo [0-9]+\./);
  assert.match(await run([executable, '--help']), /usage:/);
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), '# Installer smoke test\n');
  const settings = JSON.parse(await run([executable, 'provider', 'show', '--json', '--home', home]));
  assert.equal(settings.demoProviderEnabled, false);
  await run([executable, 'provider', 'set', 'openai', '--model', 'smoke-model', '--context-window', '64000', '--max-output', '4000', '--base-url', modelServer.baseUrl, '--home', home]);
  const output = await run([executable, 'run', 'installer smoke test', '--json', '--path', project, '--home', home]);
  const records = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.at(-1).state, 'completed');
  assert.equal(records.at(-1).type, 'result');
  assert.equal(modelServer.requests.length, 1);
  console.log(`PASS: ${origin} installer, archive verification, installed launcher, help/version, and bundled engine task.`);
} finally {
  if (await Bun.file(executable).exists()) await run([executable, 'engine', 'stop', '--cancel', '--home', home]).catch(error => console.error(error.message));
  server?.stop(true);
  modelServer.stop();
  await rm(temporary, { recursive: true, force: true });
}
