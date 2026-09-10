// Memory benchmark for the packaged artifacts. macOS physical footprint or
// Linux PSS per process, summed over the process set. Not a reference-machine measurement unless run there.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const DIST = path.join(ROOT, "dist");
const results = path.join(ROOT, "results");
mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "jolo-bench-"));
const rss = (pid) => { try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024; } catch { return null; } };

function measure(pids, label) {
  pids = [...new Set(pids)].filter(Boolean);
  // A process that exits between discovery and sampling (for example an engine candidate that lost the
  // ownership race) is recorded as missing rather than failing the sample.
  const missing = [];
  const rows = pids.map((pid) => ({ pid, rssBytes: rss(pid) })).filter((row) => { if (row.rssBytes === null) { missing.push(row.pid); return false; } return true; });
  pids = rows.map((row) => row.pid);
  for (const row of rows) { try { row.command = execFileSync("ps", ["-o", "command=", "-p", String(row.pid)], { encoding: "utf8" }).trim().slice(0, 160); } catch { row.command = ""; } }
  if (process.platform === "darwin") {
    const file = path.join(results, `benchmark-${label}-footprint.json`);
    execFileSync("/usr/bin/footprint", ["--noCategories", "-j", file, ...pids.map(String)], { stdio: "ignore" });
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const row of rows) { const p = data.processes.find((x) => x.pid === row.pid); row.footprintBytes = p?.auxiliary?.phys_footprint ?? null; row.peakBytes = p?.auxiliary?.phys_footprint_peak ?? null; row.name = p?.name ?? null; }
  } else {
    for (const row of rows) { const m = readFileSync(`/proc/${row.pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)\s+kB$/m); row.footprintBytes = m ? Number(m[1]) * 1024 : null; }
  }
  const total = rows.reduce((sum, r) => sum + (r.footprintBytes ?? 0), 0);
  return { label, missingPids: missing, primary: process.platform === "darwin" ? "phys_footprint" : "pss", totalMiB: +(total / 1048576).toFixed(1), processes: rows.map((r) => ({ ...r, rssMiB: +(r.rssBytes / 1048576).toFixed(1), footprintMiB: r.footprintBytes === null ? null : +(r.footprintBytes / 1048576).toFixed(1), peakMiB: r.peakBytes ? +(r.peakBytes / 1048576).toFixed(1) : undefined })) };
}

async function enginePid(home, profile = "default") {
  const meta = path.join(home, "run", profile, "engine.json");
  for (let i = 0; i < 200; i += 1) { if (existsSync(meta)) return JSON.parse(readFileSync(meta, "utf8")).pid; await sleep(50); }
  throw new Error("engine did not publish");
}

const report = { measuredAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), release: os.release() }, bun: Bun.version, samples: [], caveat: "Single samples on the build host, not the 8 GiB reference machines; idle packaged artifacts without a model run." };
const cli = path.join(DIST, "cli/bin/jolo");
const compiled = path.join(DIST, "compiled/jolo");

// 1. Bundled engine idle (started by a headless status call, then left alone).
{
  const home = mkdtempSync(path.join(short, "e-"));
  const repo = path.join(home, "repo"); mkdirSync(repo);
  execFileSync(cli, ["provider", "show", "--json", "--home", home], { env: { ...process.env, JOLO_IDLE_MS: "60000" }, stdio: "ignore" });
  const pid = await enginePid(home);
  await sleep(1500);
  report.samples.push({ ...measure([pid], "engine-bundled-idle"), note: "bundled engine.js on the pinned Bun after reading settings, no clients" });
  execFileSync(cli, ["engine", "stop", "--home", home], { stdio: "ignore" });
}

// 2. Compiled engine idle.
if (existsSync(compiled)) {
  const home = mkdtempSync(path.join(short, "c-"));
  const repo = path.join(home, "repo"); mkdirSync(repo);
  execFileSync(compiled, ["provider", "show", "--json", "--home", home], { env: { ...process.env, JOLO_IDLE_MS: "60000" }, stdio: "ignore" });
  const pid = await enginePid(home);
  await sleep(1500);
  report.samples.push({ ...measure([pid], "engine-compiled-idle"), note: "single-file compiled engine after reading settings, no clients" });
  execFileSync(compiled, ["engine", "stop", "--home", home], { stdio: "ignore" });
}

// 3. Interactive client plus engine, idle in a PTY.
{
  const home = mkdtempSync(path.join(short, "t-"));
  const repo = path.join(home, "repo"); mkdirSync(repo);
  let out = "";
  const child = Bun.spawn([cli, repo, "--home", home], { env: { ...process.env, JOLO_IDLE_MS: "60000", CI: "0" }, terminal: { rows: 30, cols: 100, data(_t, d) { out += new TextDecoder().decode(d); } } });
  const pid = await enginePid(home);
  for (let i = 0; i < 200 && !out.includes("connected"); i += 1) await sleep(50);
  await sleep(1500);
  // The launcher script execs Bun, so the child's pid is the client itself.
  report.samples.push({ ...measure([child.pid, pid], "tui-plus-engine-idle"), note: "Ink client (bundled chunk) in a PTY plus the engine, idle after connecting" });
  child.terminal.write("q");
  await Promise.race([child.exited, sleep(5000)]);
  if (child.exitCode === null) child.kill();
  child.terminal?.close();
  execFileSync(cli, ["engine", "stop", "--home", home], { stdio: "ignore" });
}

// 4. Packaged desktop app in smoke mode, sampled while it holds at the end.
const appBinary = path.join(DIST, "desktop", `Jolo-${process.platform}-${process.arch}`, process.platform === "darwin" ? "Jolo.app/Contents/MacOS/Jolo" : "Jolo");
if (existsSync(appBinary)) {
  const home = mkdtempSync(path.join(short, "d-"));
  const project = path.join(home, "repo"); mkdirSync(path.join(project, "src"), { recursive: true }); writeFileSync(path.join(project, "src/app.js"), "export const answer = 42;\n");
  const smokeResults = path.join(home, "smoke-results");
  const child = Bun.spawn([appBinary], { env: { ...process.env, JOLO_HOME: home, JOLO_DESKTOP_SMOKE: "1", JOLO_SMOKE_PROJECT: project, JOLO_SMOKE_RESULTS: smokeResults, JOLO_SMOKE_HOLD_MS: "14000", JOLO_IDLE_MS: "60000", JOLO_FAKE_STEPS: "2", JOLO_FAKE_DELAY_MS: "10" }, stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  // Wait for the smoke report, then sample during the hold: all app processes plus the engine.
  for (let i = 0; i < 1200 && !existsSync(path.join(smokeResults, "smoke.json")); i += 1) { if (child.exitCode !== null) break; await sleep(100); }
  if (existsSync(path.join(smokeResults, "smoke.json"))) {
    // Only this launch: the app's own helpers plus the engine that serves this home (earlier runs' engines idle for a while).
    const all = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).trim().split("\n").map((line) => { const m = line.trim().match(/^(\d+)\s+(.*)$/); return m && { pid: Number(m[1]), command: m[2] }; }).filter(Boolean);
    const appRoot = appBinary.replace("/Contents/MacOS/Jolo", "");
    const pids = all.filter((p) => p.command.startsWith(appRoot) && (!p.command.includes("engine.js serve") || p.command.includes(home))).map((p) => p.pid);
    const engine = await enginePid(home).catch(() => null);
    report.samples.push({ ...measure([...pids, engine], "desktop-packaged-after-smoke"), note: "packaged Electron app immediately after the smoke flow (browser page, terminal, command run, two screenshot readbacks)" });
    await sleep(8000);
    report.samples.push({ ...measure([...pids, engine], "desktop-packaged-settled-8s"), note: "same processes eight seconds later with the live page and terminal still open; transient GPU allocations should have drained" });
  } else {
    report.samples.push({ label: "desktop-packaged-after-smoke", error: `smoke did not complete: ${(await stderr).slice(-800)}` });
  }
  await Promise.race([child.exited, sleep(15000)]);
  if (child.exitCode === null) child.kill();
  try { execFileSync(cli, ["engine", "stop", "--cancel", "--home", home], { stdio: "ignore" }); } catch { /* already gone */ }
}

const file = path.join(results, `benchmark-${process.platform}-${process.arch}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
for (const sample of report.samples) {
  if (sample.error) { console.log(`${sample.label}: ${sample.error}`); continue; }
  console.log(`${sample.label.padEnd(30)} ${String(sample.totalMiB).padStart(7)} MiB`);
  for (const p of sample.processes) console.log(`    ${String(p.footprintMiB).padStart(7)} MiB  ${(p.name ?? "").padEnd(24)} ${p.command}`);
}
console.log(`written ${path.relative(ROOT, file)}`);
rmSync(short, { recursive: true, force: true });
