// Release build: bundled engine, headless CLI with a lazily loaded interactive
// chunk, desktop main bundle, a pinned Bun runtime, a CLI-only tarball, and an experimental --compile target.
import { deterministicArchive } from "./archive.js";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dir, "..");
const outArg = process.argv.indexOf("--out");
const DIST = outArg === -1 ? path.join(ROOT, "dist") : path.resolve(process.argv[outArg + 1]);
const cliOnly = process.argv.includes("--cli-only");
// Opt-in: on macOS with Bun 1.3.12 the compiled output is unsigned and Apple Silicon refuses to execute it
// (verified on the build host); the pinned-runtime layout is the release artifact until that changes.
const compile = process.argv.includes("--compile");
const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const runtimeVersion = readFileSync(path.join(ROOT, ".bun-version"), "utf8").trim();
if (Bun.version !== runtimeVersion) throw new Error(`release builds require Bun ${runtimeVersion}; running ${Bun.version}`);
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0);
if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8_589_934_591) throw new Error("SOURCE_DATE_EPOCH must fit the ustar timestamp field");
const build = process.env.JOLO_BUILD ?? version;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const log = (message) => console.log(`[build] ${message}`);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Ink imports react-devtools-core behind a runtime flag that is never set in production; the bundler still
// resolves it, so a stub stands in (§17.2 packaging note).
const devtoolsStub = {
  name: "stub-react-devtools",
  setup(builder) {
    builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export function connectToDevTools() {}\nexport default { connectToDevTools };\n", loader: "js" }));
  },
};

async function bundle(entrypoints, outdir, options = {}) {
  const result = await Bun.build({
    entrypoints,
    outdir,
    target: options.target ?? "bun",
    format: "esm",
    splitting: options.splitting ?? false,
    minify: true,
    sourcemap: "none",
    external: options.external ?? [],
    define: { "process.env.NODE_ENV": '"production"', "process.env.DEV": '"false"', "process.env.JOLO_BUILD": JSON.stringify(build) },
    naming: options.naming,
    plugins: [devtoolsStub],
    ...(options.compile ? { compile: { outfile: options.compile } } : {}),
  });
  if (!result.success) { for (const message of result.logs) console.error(String(message)); throw new Error(`bundle failed: ${entrypoints.join(", ")}`); }
  return result.outputs.map((o) => o.path);
}

// 1. Engine and CLI bundles (the interactive client becomes a separate chunk through code splitting).
const lib = path.join(DIST, "cli", "lib");
mkdirSync(lib, { recursive: true });
await bundle([path.join(ROOT, "apps/engine/src/main.js")], lib, { naming: "engine.js" });
await bundle([path.join(ROOT, "apps/cli/src/main.js")], lib, { splitting: true, naming: { entry: "jolo.js", chunk: "chunk-[hash].js" } });
const chunks = readdirSync(lib).filter((name) => name.startsWith("chunk-"));
log(`cli bundle: jolo.js + ${chunks.length} chunk(s) (interactive client and engine serve are lazy)`);

// 2. Pinned runtime and launcher script.
cpSync(process.execPath, path.join(lib, "bun"));
chmodSync(path.join(lib, "bun"), 0o755);
mkdirSync(path.join(DIST, "cli", "bin"), { recursive: true });
cpSync(path.join(ROOT, "scripts/cli-launcher.sh"), path.join(DIST, "cli", "bin", "jolo"));
chmodSync(path.join(DIST, "cli", "bin", "jolo"), 0o755);
writeFileSync(path.join(DIST, "cli", "VERSION"), `${version}\n`);
// `jolo update` re-runs this exact installer rather than repeating its download, verification and
// symlink swap in a second place. Shipping it inside the archive also means an update applies the
// installer the user already has, not one fetched over the network at update time.
cpSync(path.join(ROOT, "scripts/install.sh"), path.join(lib, "install.sh"));
chmodSync(path.join(lib, "install.sh"), 0o755);
// Installed documentation must work without the source tree or its relative links.
cpSync(path.join(ROOT, "apps/cli/README.md"), path.join(DIST, "cli", "README.md"));
// Native search is optional in development; setup:tgrep pins and verifies the release before bundling.
const tgrep = path.join(ROOT, 'vendor/tgrep', `${process.platform}-${process.arch}`, 'tgrep');
function bundleSearch(directory) {
  if (!existsSync(tgrep)) return;
  cpSync(tgrep, path.join(directory, 'tgrep'));
  chmodSync(path.join(directory, 'tgrep'), 0o755);
  cpSync(path.join(ROOT, 'vendor/tgrep/LICENSE'), path.join(directory, 'tgrep-LICENSE'));
  cpSync(path.join(ROOT, 'vendor/tgrep/release.json'), path.join(directory, 'tgrep-release.json'));
}
bundleSearch(lib);
log(existsSync(tgrep) ? 'tgrep native search bundled' : 'tgrep not installed; using live search (run bun run setup:tgrep to bundle it)');

// 3. Desktop main bundle (Electron's Node runtime; electron itself stays external) and renderer.
if (!cliOnly) {
  const app = path.join(DIST, "desktop-app");
  mkdirSync(path.join(app, "preload"), { recursive: true });
  mkdirSync(path.join(app, "engine"), { recursive: true });
  await bundle([path.join(ROOT, "apps/desktop/src/main/index.js")], app, { target: "node", external: ["electron"], naming: "main.js" });
  const rendererBuild = Bun.spawnSync([process.execPath, path.join(ROOT, "apps/desktop/scripts/build.js")], { stdio: ["inherit", "inherit", "inherit"] });
  if (rendererBuild.exitCode !== 0) throw new Error("renderer build failed");
  cpSync(path.join(ROOT, "apps/desktop/dist"), path.join(app, "dist"), { recursive: true });
  cpSync(path.join(ROOT, "apps/desktop/src/preload/index.cjs"), path.join(app, "preload", "index.cjs"));
  cpSync(path.join(lib, "engine.js"), path.join(app, "engine", "engine.js"));
  cpSync(path.join(lib, "bun"), path.join(app, "engine", "bun"));
  chmodSync(path.join(app, "engine", "bun"), 0o755);
  bundleSearch(path.join(app, 'engine'));
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "jolo", productName: "Jolo", version, main: "main.js", type: "module", private: true }, null, 2));
  log("desktop app directory prepared (dist/desktop-app)");
}

// 4. Experimental single-file executables (§17.2 lists what they must still prove).
if (compile) {
  const out = path.join(DIST, "compiled");
  mkdirSync(out, { recursive: true });
  // Two stages: the JS API bundles with the stub plugin into one file; the CLI compiles that file, which
  // also produces a signed executable on macOS (the API's compile output is unsigned and refused by Apple Silicon).
  const staging = path.join(out, "staging");
  mkdirSync(staging, { recursive: true });
  for (const [entry, name] of [[path.join(ROOT, "apps/engine/src/main.js"), "jolo-engine"], [path.join(ROOT, "apps/cli/src/main.js"), "jolo"]]) {
    await bundle([entry], staging, { naming: `${name}.js` });
    const outfile = path.join(out, name);
    const result = Bun.spawnSync([process.execPath, "build", path.join(staging, `${name}.js`), "--compile", "--minify", `--outfile=${outfile}`], { stdio: ["inherit", "pipe", "pipe"] });
    if (result.exitCode !== 0) { console.error(result.stderr.toString()); throw new Error(`compile failed for ${name}`); }
    log(`compiled ${name} (${(Bun.file(outfile).size / 1048576).toFixed(1)} MiB)`);
  }
  rmSync(staging, { recursive: true, force: true });
}

// 5. Release manifest and CLI tarball.
const files = {};
const walk = (dir, base) => { for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { const full = path.join(dir, name.name); const rel = path.relative(base, full); if (name.isDirectory()) walk(full, base); else if (!name.isSymbolicLink()) files[rel] = sha256(full); } };
walk(DIST, DIST);
const manifest = { version, build, bun: Bun.version, platform: process.platform, arch: process.arch, builtAt: new Date(epoch * 1000).toISOString(), files };
writeFileSync(path.join(DIST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const tarball = path.join(DIST, `jolo-cli-${process.platform}-${process.arch}.tar.gz`);
await deterministicArchive(path.join(DIST, "cli"), tarball, epoch);
const checksum = sha256(tarball);
writeFileSync(`${tarball}.sha256`, `${checksum}  ${path.basename(tarball)}\n`);
manifest.archive = { name: path.basename(tarball), sha256: checksum, size: Bun.file(tarball).size };
writeFileSync(path.join(DIST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
log(`cli tarball: ${path.basename(tarball)} (${(Bun.file(tarball).size / 1048576).toFixed(1)} MiB)`);
log(`manifest: dist/manifest.json (${Object.keys(files).length} files, build ${build})`);
