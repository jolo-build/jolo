// Type-check every program in the repository.
//
// Nothing here emits: Bun and Electron's Node run the source directly. TypeScript's own build mode
// refuses project references that disable emit, so each program is checked on its own instead. A
// program is a directory with one runtime, because the engine (Bun), the Electron main process
// (Node), the renderer (browser), and the account service (Workers) have different globals.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TSC = path.join(ROOT, "node_modules", ".bin", "tsc");

// Order runs bottom-up so a shared package reports before the applications that consume it.
const PROGRAMS = [
  "packages/protocol",
  "packages/client",
  "packages/launcher",
  "packages/markdown",
  "packages/updates",
  "apps/engine",
  "apps/cli",
  "apps/desktop/src/main",
  "apps/desktop/src/preload",
  "apps/desktop/src/renderer",
  "apps/desktop/smoke",
  "apps/desktop/scripts",
  "apps/desktop/test",
  "apps/access/src",
  "apps/access/scripts",
  "apps/access/test",
  "apps/website/src",
  "apps/website/scripts",
  "tests",
  "scripts",
  "deploy",
];

if (!existsSync(TSC)) {
  console.error("TypeScript is not installed; run `bun install`.");
  process.exit(1);
}

// A program without a configuration would be checked by nobody, so treat that as a failure.
const configured = new Set(PROGRAMS);
const missing = PROGRAMS.filter(program => !existsSync(path.join(ROOT, program, "tsconfig.json")));
if (missing.length) {
  console.error(`missing tsconfig.json: ${missing.join(", ")}`);
  process.exit(1);
}

// Catch a tsconfig.json added anywhere in the tree that this runner does not check.
const strays = [];
const skip = new Set(["node_modules", "dist", "dist-test", ".git", ".generated", ".wrangler", "smoke-results", "vendor", "results", ".releases", "public"]);
const walk = (directory) => {
  for (const entry of readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (existsSync(path.join(ROOT, child, "tsconfig.json")) && !configured.has(child)) strays.push(child);
    walk(child);
  }
};
for (const top of ["apps", "packages"]) walk(top);
if (strays.length) {
  console.error(`tsconfig.json not listed in scripts/typecheck.js: ${strays.join(", ")}`);
  process.exit(1);
}

const only = process.argv.slice(2).filter(argument => !argument.startsWith("-"));
const selected = only.length ? PROGRAMS.filter(program => only.some(name => program.includes(name))) : PROGRAMS;
if (!selected.length) {
  console.error(`no program matched ${only.join(", ")}`);
  process.exit(1);
}

let failed = 0;
for (const program of selected) {
  const result = Bun.spawnSync([TSC, "--noEmit", "-p", path.join(ROOT, program, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  if (result.exitCode === 0) {
    console.log(`ok   ${program}`);
    continue;
  }
  failed++;
  const count = (output.match(/error TS/g) ?? []).length;
  console.log(`FAIL ${program} (${count} error${count === 1 ? "" : "s"})`);
  console.log(output);
}

if (failed) {
  console.error(`\n${failed} of ${selected.length} programs failed type checking`);
  process.exit(1);
}
console.log(`\n${selected.length} programs type-check cleanly`);
