import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import path from "node:path";
import { ROOT, tempHome, removeHome, waitFor } from "./helpers.js";
import { resolvePaths, discover } from '@jolo/launcher';
import { connect } from '@jolo/client';
import { startSmokeModel, SMOKE_MODEL_KEY } from '../fixtures/smoke-model.js';

const DIST = path.join(ROOT, "dist-test"); // never clobber a release build in dist/
const homes = [];
let modelServer;
beforeAll(async () => {
  const build = Bun.spawnSync([process.execPath, path.join(ROOT, "scripts/build.js"), "--cli-only", "--out", DIST], { stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}\n${build.stdout.toString()}`);
  modelServer = startSmokeModel();
}, 240_000);
afterAll(async () => {
  for (const home of homes.splice(0)) {
    Bun.spawnSync([path.join(DIST, "cli/bin/jolo"), "engine", "stop", "--cancel", "--home", home], { stdout: "ignore", stderr: "ignore" });
    removeHome(home);
  }
  rmSync(DIST, { recursive: true, force: true });
  modelServer?.stop();
});

/**
 * Run one packaged binary to completion and report its exit code and decoded output.
 * @param {string[]} command
 * @param {{ home?: string, env?: Record<string, string>, cwd?: string }} [options]
 */
function run(command, { home, env = {}, cwd } = {}) {
  const proc = Bun.spawnSync(command, { cwd: cwd ?? ROOT, env: { ...process.env, JOLO_IDLE_MS: "1500", OPENAI_API_KEY: SMOKE_MODEL_KEY, JOLO_CREDENTIALS: "session", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

async function runModelTask(jolo, home, repo, prompt) {
  const configured = run([jolo, 'provider', 'set', 'openai', '--model', 'smoke-model', '--context-window', '64000', '--max-output', '4000', '--base-url', modelServer.baseUrl, '--home', home]);
  expect(configured.code).toBe(0);
  const child = Bun.spawn([jolo, 'run', prompt, '--json', '--path', repo, '--home', home], { env: { ...process.env, OPENAI_API_KEY: SMOKE_MODEL_KEY, JOLO_CREDENTIALS: 'session' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

describe("release build", () => {
  test('archive checksum covers the finished tarball and the launcher works through relative symlinks', () => {
    const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
    const archive = readFileSync(path.join(DIST, manifest.archive.name));
    const checksum = createHash('sha256').update(archive).digest('hex');
    expect(manifest.archive.sha256).toBe(checksum);
    expect(manifest.archive.size).toBe(archive.length);
    expect(readFileSync(path.join(DIST, `${manifest.archive.name}.sha256`), 'utf8')).toBe(`${checksum}  ${manifest.archive.name}\n`);
    const bin = path.join(DIST, 'installed bin');
    mkdirSync(bin);
    symlinkSync('../cli/bin/jolo', path.join(bin, 'jolo'));
    const version = run([path.join(bin, 'jolo'), '--version'], { cwd: bin, env: { PATH: '/usr/bin:/bin' } });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(`jolo ${manifest.build}`);
    const help = run([path.join(bin, 'jolo'), '--help'], { cwd: bin, env: { PATH: '/usr/bin:/bin' } });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage:');
  });

  test('the packaged engine and stdio search bridge run without the source tree', async () => {
    const lib = path.join(DIST, 'cli/lib');
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, 'repo'); mkdirSync(repo); writeFileSync(path.join(repo, 'file.txt'), 'packaged-marker\n');
    const paths = resolvePaths({ home });
    const child = Bun.spawn([path.join(lib, 'bun'), path.join(lib, 'engine.js'), 'serve', '--home', home, '--idle-ms', '10000'], { cwd: home, env: { ...process.env, JOLO_TGREP: undefined }, stdout: 'ignore', stderr: 'pipe' });
    const diagnostics = new Response(child.stderr).text();
    let client;
    try {
      await waitFor(() => discover(paths), { timeoutMs: 10_000 });
      client = await connect({ socketPath: paths.socketPath, token: readFileSync(paths.tokenPath, 'utf8').trim(), clientKind: 'test' });
      const project = await client.call('project.open', { path: repo });
      if (existsSync(path.join(lib, 'tgrep'))) await waitFor(async () => (await client.call('workspace.search', { workspaceId: project.workspaceId, pattern: 'packaged-marker' })).engine === 'tgrep', { timeoutMs: 10_000, label: 'packaged native index' });
      const mcp = Bun.spawn([path.join(lib, 'bun'), path.join(lib, 'engine.js'), 'search-mcp', '--socket', paths.socketPath, '--token-file', paths.tokenPath, '--workspace', project.workspaceId], { cwd: home, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      const output = new Response(mcp.stdout).text(), errors = new Response(mcp.stderr).text();
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_text', arguments: { pattern: 'packaged-marker' } } }) + '\n');
      mcp.stdin.end();
      expect(await mcp.exited).toBe(0); expect(await errors).toBe('');
      const result = JSON.parse((await output).trim()).result;
      expect(result.isError).toBe(false); expect(result.structuredContent.matches[0].path).toBe('file.txt');
    } finally {
      await client?.close(); child.kill('SIGTERM'); await child.exited;
      expect(await diagnostics).not.toContain('engine failed');
    }
  }, 30_000);

  test("the CLI tarball layout runs headless with its bundled engine and pinned runtime, without the interactive chunk", async () => {
    const lib = path.join(DIST, "cli/lib");
    expect(existsSync(path.join(lib, "jolo.js"))).toBe(true);
    expect(existsSync(path.join(lib, "engine.js"))).toBe(true);
    expect(statSync(path.join(lib, "bun")).mode & 0o111).toBeTruthy();
    if (existsSync(path.join(ROOT, 'vendor/tgrep', `${process.platform}-${process.arch}`, 'tgrep'))) {
      expect(statSync(path.join(lib, 'tgrep')).mode & 0o111).toBeTruthy();
      expect(readFileSync(path.join(lib, 'tgrep-LICENSE'), 'utf8')).toContain('MIT License');
      const native = run([path.join(lib, 'tgrep'), '--version']);
      const vendorRelease = JSON.parse(readFileSync(path.join(lib, 'tgrep-release.json'), 'utf8'));
      expect(native.code).toBe(0); expect(native.stdout.trim()).toBe(`tgrep ${vendorRelease.version}`);
    }
    // Code splitting yields shared chunks (client, protocol) plus the interactive chunk that carries Ink and its
    // layout engine. Only the latter must be unnecessary for headless use: hide exactly that and run anyway.
    const chunks = readdirSync(lib).filter((name) => name.startsWith("chunk-") && /yoga|react-reconciler/.test(readFileSync(path.join(lib, name), "utf8")));
    expect(chunks.length).toBeGreaterThan(0);
    const hidden = path.join(DIST, "cli", "hidden-chunks");
    mkdirSync(hidden, { recursive: true });
    for (const chunk of chunks) Bun.spawnSync(["mv", path.join(lib, chunk), path.join(hidden, chunk)]);
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo"); mkdirSync(repo, { recursive: true }); writeFileSync(path.join(repo, "README.md"), "# packaged\n");
    try {
      const jolo = path.join(DIST, "cli/bin/jolo");
      const demo = run([jolo, "provider", "set", "fake", "--home", home], { env: { NODE_ENV: "development", JOLO_FAKE_STEPS: "1" } });
      expect(demo.code).not.toBe(0);
      expect(demo.stderr).toContain("only available in development mode");
      expect(JSON.parse(run([jolo, "provider", "show", "--json", "--home", home]).stdout).demoProviderEnabled).toBe(false);
      const requestsBefore = modelServer.requests.length;
      const result = await runModelTask(jolo, home, repo, "packaged hello");
      if (result.code !== 0) console.error(`packaged run failed:\n${result.stderr.slice(-1500)}`);
      expect(result.code).toBe(0);
      const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ type: "result", state: "completed" });
      expect(modelServer.requests.length).toBe(requestsBefore + 1);
      const status = run([path.join(DIST, "cli/bin/jolo"), "status", "--json", "--home", home]);
      expect(JSON.parse(status.stdout).engine.build).not.toBe("dev");
      const account = run([path.join(DIST, "cli/bin/jolo"), "whoami", "--json", "--home", home]);
      expect(account.code).toBe(0);
      expect(JSON.parse(account.stdout)).toMatchObject({ state: 'signed_out', account: null, source: 'none' });
    } finally {
      for (const chunk of chunks) Bun.spawnSync(["mv", path.join(hidden, chunk), path.join(lib, chunk)]);
      rmSync(hidden, { recursive: true, force: true });
    }
    expect(existsSync(path.join(DIST, `jolo-cli-${process.platform}-${process.arch}.tar.gz`))).toBe(true);
    expect(existsSync(path.join(DIST, "manifest.json"))).toBe(true);
  }, 60_000);

  const compiledAvailable = existsSync(path.join(DIST, "compiled/jolo")) && Bun.spawnSync([path.join(DIST, "compiled/jolo"), "--help"], { stdout: "ignore", stderr: "ignore" }).exitCode !== null;
  test.skipIf(!compiledAvailable)("compiled single-file executables serve and run a task (only when built with --compile and executable here)", async () => {
    const jolo = path.join(DIST, "compiled/jolo");
    const engine = path.join(DIST, "compiled/jolo-engine");
    expect(existsSync(jolo) && existsSync(engine)).toBe(true);
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo"); mkdirSync(repo, { recursive: true }); writeFileSync(path.join(repo, "README.md"), "# compiled\n");
    const result = await runModelTask(jolo, home, repo, "compiled hello");
    expect(result.code).toBe(0);
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ type: "result", state: "completed" });
    const status = run([jolo, "status", "--json", "--home", home]);
    expect(JSON.parse(status.stdout).engine.pid).toBeGreaterThan(0);
    run([jolo, "engine", "stop", "--home", home]);
  }, 60_000);
});
