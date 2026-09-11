import { expect, test } from "bun:test";
import { currentModelLabel, modelFields, modelForm, modelSettingsPatch, modelTargets, parseModelCommand, saveModelConfig, selectedAgent } from "../src/tui/model-config.js";
import { createPromptState, promptReducer } from "../src/tui/prompt-history.js";
import { DEMO_PROVIDER_SETTINGS } from "@jolo/protocol";

const jolo = { id: "jolo" };
const provider = { name: "openai", model: "test-model", contextWindowTokens: 64000, maxOutputTokens: 4000 };
const patch = { model: { preset: 'openai', model: 'test-model', effort: null, contextWindowTokens: 64000, maxOutputTokens: 4000 }, providers: { openai: { baseUrl: null } } };
const configured = () => modelForm(jolo, { provider });

test("agent selection distinguishes Jolo from hosted agents and refuses unavailable agents", () => {
  expect(selectedAgent(jolo)).toBeNull();
  expect(selectedAgent({ id: "claude", transport: "claude-stream", available: true })).toBe("claude");
  expect(() => selectedAgent({ id: "missing", displayName: "Missing", available: false })).toThrow("not installed");
  expect(() => selectedAgent({ id: "shell", transport: "pty", available: true })).toThrow("separate terminal");
  expect(modelTargets([{ id: "custom", transport: "acp", supportsModel: false, supportsEffort: false }]).map((entry) => entry.id)).toEqual(["jolo", "custom"]);
});

test("/model is a local command, not a task or a prompt-history entry", () => {
  expect(parseModelCommand(" /model ")).toEqual({ target: null });
  expect(parseModelCommand("/model codex")).toEqual({ target: "codex" });
  for (const text of ["/models", "explain /model", "/model.js"]) expect(parseModelCommand(text)).toBeNull();
  let state = promptReducer(createPromptState(), { type: "submit", prompt: "fix this" });
  state = promptReducer(state, { type: "edit", chunk: "/model" });
  state = promptReducer(state, { type: "clear" });
  expect(state.value).toBe("");
  expect(promptReducer(state, { type: "previous" }).value).toBe("fix this");
});

test("configuration edits preserve supported values and allow discovered limits", () => {
  expect(modelSettingsPatch(jolo, configured())).toEqual(patch);
  expect(modelSettingsPatch(jolo, { ...configured(), name: 'fake' }).model).toMatchObject({ preset: 'fake', model: 'fake' });
  const empty = { ...modelForm(jolo, { provider: null }), name: "openai", model: "new-model" };
  expect(modelSettingsPatch(jolo, empty).model.contextWindowTokens).toBeNull();
  for (const patch of [{ maxOutputTokens: "64000" }, { contextWindowTokens: "NaN" }, { model: "" }, { baseUrl: "not a url" }, { apiKey: "short" }, { apiKey: "x".repeat(4097) }]) {
    expect(() => modelSettingsPatch(jolo, { ...configured(), ...patch })).toThrow();
  }
  expect(modelFields(jolo, { name: "fake" }).map((field) => field.id)).toEqual(["name", "save"]);
});

test("terminal demo choices and labels follow the engine capability", () => {
  for (const settings of [{ provider: null }, { provider: null, demoProviderEnabled: false }, { provider: DEMO_PROVIDER_SETTINGS, demoProviderEnabled: false }]) {
    const form = modelForm(jolo, settings);
    expect(form.name).toBe("openai");
    expect(modelFields(jolo, form, settings)[0].choices).toEqual(["openai"]);
    expect(currentModelLabel(settings)).toBe("Configure provider");
  }
  const development = { provider: null, demoProviderEnabled: true };
  const form = modelForm(jolo, development);
  expect(form.name).toBe("fake");
  expect(modelFields(jolo, form, development)[0].choices).toEqual(["fake", "openai"]);
  expect(currentModelLabel(development)).toBe("Demo provider");
});

test("hosted-agent patches affect only supported fields, and blank resets the default", () => {
  const target = { id: "agent", supportsModel: true, supportsEffort: false };
  expect(modelSettingsPatch(target, { model: "  test-large  ", effort: "ignored" })).toEqual({ agents: { agent: { model: "test-large" } } });
  expect(modelSettingsPatch(target, { model: " ", effort: "" })).toEqual({ agents: { agent: { model: null } } });
  expect(modelTargets([target, { id: "shell", supportsModel: false }]).map((entry) => entry.id)).toEqual(["jolo", "agent"]);
  expect(currentModelLabel({ provider, agents: { agent: { model: "test-large" } } }, { agentId: "agent" })).toBe("agent · test-large");
});

test("keys use the credential RPC only; an empty key leaves existing credentials alone", async () => {
  const calls = [];
  const client = { call: async (method, params) => { calls.push([method, params]); return method === "credential.set" ? { stored: "session" } : { settings: {} }; } };
  const key = "test-secret-key";
  expect(await saveModelConfig(client, jolo, { ...configured(), apiKey: key })).toContain("engine exits");
  expect(calls).toEqual([["credential.set", { provider: "openai", value: key }], ["settings.update", patch]]);
  calls.length = 0;
  await saveModelConfig(client, jolo, configured());
  expect(calls).toEqual([["settings.update", patch]]);
  calls.length = 0;
  await expect(saveModelConfig(client, jolo, { ...configured(), model: "", apiKey: key })).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("failed credential writes do not change the provider or reveal the key in an error", async () => {
  const calls = [];
  const client = { call: async (method) => { calls.push(method); throw new Error("failed test-secret-key"); } };
  await expect(saveModelConfig(client, jolo, { ...configured(), apiKey: "test-secret-key" })).rejects.toThrow("failed [redacted]");
  expect(calls).toEqual(["credential.set"]);
});
