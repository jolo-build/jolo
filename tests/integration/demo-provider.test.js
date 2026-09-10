import { expect, test } from "bun:test";
import path from "node:path";
import { DEMO_PROVIDER_SETTINGS } from "@jolo/protocol";
import { ProviderFactory } from "../../apps/engine/src/providers/index.js";
import { BUILTIN_PRESETS, createProviderCatalog } from "../../apps/engine/src/providers/presets.js";
import { writeFileSync } from "node:fs";
import { ENGINE_ENTRY, startEngine, tempHome, removeHome, openSession, waitFor } from "./helpers.js";

test("the provider factory refuses implicit and explicit demos in production", async () => {
  const factory = new ProviderFactory({ env: { NODE_ENV: "production" } });
  await expect(factory.create(null)).rejects.toThrow("no model provider is configured");
  await expect(factory.create(DEMO_PROVIDER_SETTINGS)).rejects.toThrow("only available in development mode");
  await expect(factory.create({ preset: "fake", model: "fake" }, { resolved: { protocol: "fake" } })).rejects.toThrow("only available in development mode");
  const development = new ProviderFactory({ env: { NODE_ENV: "development" } });
  expect((await development.create(null)).settings.name).toBe("fake");
});

test("production catalogs omit built-in and custom demo presets", () => {
  const home = tempHome();
  try {
    writeFileSync(path.join(home, "demo-alias.json"), JSON.stringify({ ...BUILTIN_PRESETS.find(preset => preset.id === "fake"), id: "demo-alias" }));
    const production = createProviderCatalog({ dir: home, env: { NODE_ENV: "production" } });
    expect(production.list().some(preset => preset.protocol === "fake")).toBe(false);
    expect(() => production.get("demo-alias")).toThrow("unknown provider");
    const development = createProviderCatalog({ dir: home, env: { NODE_ENV: "development" } });
    expect(development.get("fake").protocol).toBe("fake");
    expect(development.get("demo-alias").protocol).toBe("fake");
  } finally { removeHome(home); }
});

test("production bundles disable demos even with saved settings and a development environment", async () => {
  const home = tempHome();
  let engine, client;
  const run = async (sessionId, requestId) => {
    const { run } = await client.call("run.start", { sessionId, requestId, prompt: "demo mode check" });
    return waitFor(async () => {
      const snapshot = await client.call("run.snapshot", { runId: run.id });
      return ["completed", "failed"].includes(snapshot.run.state) && snapshot;
    }, { label: "provider run", timeoutMs: 10000 });
  };
  try {
    // Source development mode still works, including explicitly selecting the demo.
    engine = await startEngine({ home, env: { NODE_ENV: "development" }, fakeSteps: 1, fakeDelayMs: 1 });
    client = await engine.connect();
    expect((await client.call("settings.get", {})).settings.demoProviderEnabled).toBe(true);
    await client.call("settings.update", { provider: DEMO_PROVIDER_SETTINGS });
    const { session } = await openSession(client, home);
    expect((await run(session.id, "development")).run.state).toBe("completed");
    await client.close(); client = null;
    await engine.stop(); engine = null;

    const entrypoint = path.join(home, "release", "engine.js");
    const built = await Bun.build({ entrypoints: [ENGINE_ENTRY], outdir: path.dirname(entrypoint), naming: "engine.js", target: "bun", minify: true,
      define: { "process.env.NODE_ENV": '"production"', "process.env.DEV": '"false"', "process.env.JOLO_BUILD": '"release-test"' } });
    expect(built.success).toBe(true);
    engine = await startEngine({ home, entrypoint, env: { NODE_ENV: "development", DEV: "true", JOLO_BUILD: "dev" } });
    client = await engine.connect();
    expect((await client.call("settings.get", {})).settings).toMatchObject({ provider: null, demoProviderEnabled: false });
    expect((await client.call("provider.presets", {})).presets.some(preset => preset.protocol === "fake")).toBe(false);
    await expect(client.call("provider.models", { preset: "fake" })).rejects.toThrow("only available in development mode");
    await expect(client.call("settings.update", { model: { preset: "fake", model: "fake" } })).rejects.toThrow("only available in development mode");
    await expect(client.call("settings.update", { provider: DEMO_PROVIDER_SETTINGS })).rejects.toThrow("only available in development mode");
    await expect(client.call("settings.update", { demoProviderEnabled: true })).rejects.toThrow("invalid params");
    expect((await client.call("engine.status", {})).agent).toBe("unconfigured");
    const failed = await run(session.id, "production-saved-demo");
    expect(failed.run.state).toBe("failed");
    expect(failed.run.failure).toContain("no model provider is configured");
    expect(failed.messages.filter(message => message.runId === failed.run.id && message.role === "assistant" && message.kind === "text")).toHaveLength(0);

    // Clearing configuration must not activate a hidden demo fallback either.
    await client.call("settings.update", { provider: null });
    expect((await run(session.id, "production-unconfigured")).run.state).toBe("failed");
    // Hosted agents can still save their configuration without a native provider.
    expect((await client.call("settings.update", { agents: { codex: { model: "test-model" } } })).settings.agents.codex.model).toBe("test-model");
  } finally {
    await client?.close();
    await engine?.stop();
    removeHome(home);
  }
}, 30000);
