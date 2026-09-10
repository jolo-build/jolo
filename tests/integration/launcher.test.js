import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolvePaths, connectOrStart, tryConnect, discover } from "@jolo/launcher";
import { ENGINE_ENTRY, tempHome, waitFor, removeHome } from "./helpers.js";

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function engineCommand(home, profile) {
  return [process.execPath, ENGINE_ENTRY, "serve", "--home", home, "--profile", profile, "--idle-ms", "600"];
}

async function stopEngine(paths) {
  const client = await tryConnect(paths, { clientKind: "control" });
  if (!client) return;
  try { await client.call("engine.stop", { cancelActive: true }); } catch { /* already stopping */ }
  await client.close();
  await waitFor(() => !discover(paths), { label: "endpoint removed" });
}

describe("launcher", () => {
  test("starts a detached engine once and attaches concurrent launchers to the same boot", async () => {
    const home = tempHome();
    const paths = resolvePaths({ home, profile: "l" });
    cleanups.push(async () => { await stopEngine(paths); removeHome(home); });
    expect(discover(paths)).toBeNull();
    expect(await tryConnect(paths)).toBeNull();

    const options = { paths, engineCommand: engineCommand(home, "l"), env: { JOLO_FAKE_STEPS: "2", JOLO_FAKE_DELAY_MS: "5" }, clientKind: "headless" };
    const [first, second, third] = await Promise.all([connectOrStart(options), connectOrStart(options), connectOrStart(options)]);
    const boots = new Set([first.client.hello.engineBootId, second.client.hello.engineBootId, third.client.hello.engineBootId]);
    expect(boots.size).toBe(1);
    expect([first, second, third].filter((r) => r.started).length).toBeGreaterThanOrEqual(1);
    const status = await first.client.call("engine.status", {});
    expect(status.clients).toBe(3);
    for (const r of [first, second, third]) await r.client.close();

    const again = await connectOrStart(options);
    expect(again.started).toBe(false);
    expect(again.client.hello.engineBootId).toBe(first.client.hello.engineBootId);
    await again.client.close();
  });

  test("a stale endpoint from a dead engine is replaced by the next owner", async () => {
    const home = tempHome();
    const paths = resolvePaths({ home, profile: "s" });
    cleanups.push(async () => { await stopEngine(paths); removeHome(home); });
    const child = Bun.spawn(engineCommand(home, "s"), { stdout: "ignore", stderr: "ignore" });
    await waitFor(() => discover(paths), { label: "first endpoint" });
    const stale = discover(paths);
    child.kill("SIGKILL");
    await child.exited;
    expect(discover(paths)).not.toBeNull(); // metadata left behind by the crash
    expect(await tryConnect(paths)).toBeNull(); // nothing listens

    const { client, started } = await connectOrStart({ paths, engineCommand: engineCommand(home, "s"), clientKind: "headless" });
    expect(started).toBe(true);
    expect(client.hello.engineBootId).not.toBe(stale.metadata.engineBootId);
    expect(discover(paths).metadata.engineBootId).toBe(client.hello.engineBootId);
    await client.close();
  });

  test("engine failures are reported instead of waiting for the deadline", async () => {
    const home = tempHome();
    const paths = resolvePaths({ home, profile: "f" });
    cleanups.push(() => removeHome(home));
    const startedAt = Date.now();
    mkdirSync(paths.databasePath, { recursive: true }); // a directory where the engine expects its database file
    await expect(connectOrStart({ paths, engineCommand: [process.execPath, ENGINE_ENTRY, "serve", "--home", home, "--profile", "f"], deadlineMs: 10_000 })).rejects.toMatchObject({ code: "unavailable" });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  });
});
