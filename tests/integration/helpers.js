// Shared fixtures for integration tests: temporary profiles and real engine processes.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths, discover } from "@jolo/launcher";
import { connect } from "@jolo/client";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ENGINE_ENTRY = path.join(ROOT, "apps", "engine", "src", "main.js");
export const CLI_ENTRY = path.join(ROOT, "apps", "cli", "src", "main.js");
export const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

export function tempHome() {
  return mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "jolo-t-"));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function removeHome(home) {
  rmSync(home, { recursive: true, force: true });
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export async function exitWithin(child, ms) {
  return Promise.race([child.exited, sleep(ms).then(() => "timeout")]);
}

/**
 * Start a real engine process for a temporary profile.
 * @param {{ home: string, profile?: string, idleMs?: number, fakeSteps?: number, fakeDelayMs?: number, env?: Record<string, string> }} options
 */
export async function startEngine(options) {
  const profile = options.profile ?? "t";
  const paths = resolvePaths({ home: options.home, profile });
  const child = Bun.spawn([process.execPath, ENGINE_ENTRY, "serve", "--home", options.home, "--profile", profile, "--idle-ms", String(options.idleMs ?? 2000)], {
    env: { ...process.env, JOLO_FAKE_STEPS: String(options.fakeSteps ?? 10), JOLO_FAKE_DELAY_MS: String(options.fakeDelayMs ?? 30), ...(options.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const previousBoot = discover(paths)?.metadata.engineBootId ?? null; // a crashed engine may leave metadata behind
  const deadline = Date.now() + 10_000;
  for (;;) {
    const endpoint = discover(paths);
    if (endpoint && endpoint.metadata.engineBootId !== previousBoot && existsSync(paths.socketPath)) break;
    if (child.exitCode !== null) throw new Error(`engine exited ${child.exitCode}: ${await stderr}`);
    if (Date.now() > deadline) throw new Error("engine start timeout");
    await sleep(20);
  }
  const token = () => readFileSync(paths.tokenPath, "utf8").trim();
  return {
    child,
    paths,
    endpoint: () => discover(paths),
    token,
    connect: (overrides = {}) => connect({ socketPath: paths.socketPath, token: token(), clientKind: "test", build: "test", ...overrides }),
    stderr: () => stderr,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exitWithin(child, 5000);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}

/** Open a project + session on a connected client; returns ids and the session cursor. */
export async function openSession(client, home) {
  const project = await client.call("project.open", { path: home });
  const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "test" });
  return { project, session, cursor };
}
