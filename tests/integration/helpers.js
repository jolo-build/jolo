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

/**
 * One turn of the fake provider's script, the way a `JOLO_FAKE_SCRIPT` file records it. A turn
 * carries only the parts its case needs: `text` streams a fragment at a time, `rawArguments` lets a
 * case send arguments the tool parser should reject, and `error.once` fires on the first attempt
 * only so the retry replays the same entry.
 * @typedef {{
 *   text?: string[],
 *   reasoning?: string,
 *   toolCalls?: { name: string, arguments?: any, rawArguments?: any }[],
 *   error?: { category?: string, retryable?: boolean, once?: boolean, partialText?: string, message?: string },
 *   usage?: { inputTokens?: number, outputTokens?: number },
 * }} FakeScriptTurn
 */

/**
 * What `run.snapshot` answers with, as the suites read it. The engine hands back a decoded wire
 * object, so the run and its messages stay open here; the point of naming the shape is that suites
 * declare `let snapshot` and fill it inside a `waitFor` callback, and without a declared type the
 * compiler only ever sees the unassigned declaration.
 * @typedef {{ run: any, messages: any[] }} RunSnapshot
 */

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
 * @param {{ home: string, profile?: string, entrypoint?: string, idleMs?: number, fakeSteps?: number, fakeDelayMs?: number, env?: Record<string, string> }} options
 */
export async function startEngine(options) {
  const profile = options.profile ?? "t";
  const paths = resolvePaths({ home: options.home, profile });
  const child = Bun.spawn([process.execPath, options.entrypoint ?? ENGINE_ENTRY, "serve", "--home", options.home, "--profile", profile, "--idle-ms", String(options.idleMs ?? 2000)], {
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
