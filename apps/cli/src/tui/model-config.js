import { AgentModelPatchSchema, ProviderSettingsSchema } from "@jolo/protocol";

export function parseModelCommand(text) {
  const match = text.trim().match(/^\/model(?:\s+(.+))?$/i);
  return match ? { target: match[1]?.trim() ?? null } : null;
}

export function modelTargets(agents) {
  return [{ id: "jolo", displayName: "Jolo provider" }, ...agents.filter((agent) => agent.supportsModel || agent.supportsEffort || (agent.transport && agent.transport !== "pty"))];
}

export function selectedAgent(target) {
  if (target.id === "jolo") return null;
  if (target.available === false) throw new Error(`${target.displayName} is not installed or is unavailable on the engine's PATH.`);
  if (target.transport === "pty") throw new Error("This agent only supports a separate terminal, not chat prompts.");
  return target.id;
}

export function modelForm(target, settings) {
  if (target.id !== "jolo") {
    const current = settings.agents?.[target.id] ?? target;
    return { model: current.model ?? "", effort: current.effort ?? "" };
  }
  const p = settings.provider;
  return { name: p?.name ?? "fake", model: p?.model ?? "", contextWindowTokens: String(p?.contextWindowTokens ?? ""), maxOutputTokens: String(p?.maxOutputTokens ?? ""), baseUrl: p?.baseUrl ?? "", reasoningEffort: p?.reasoningEffort ?? "", apiKey: "" };
}

export function modelFields(target, form) {
  if (target.id !== "jolo") return [
    ...(target.supportsModel ? [{ id: "model", label: "Model", limit: 200, placeholder: "agent default" }] : []),
    ...(target.supportsEffort ? [{ id: "effort", label: "Effort", limit: 40, placeholder: "agent default" }] : []),
    ...(target.available && target.supportsModel ? [{ id: "discover", label: "Find models", action: true }] : []),
    { id: "save", label: "Save and use", action: true },
  ];
  return [
    { id: "name", label: "Provider", choices: ["fake", "openai"] },
    ...(form.name === "fake" ? [] : [
      { id: "model", label: "Model", limit: 100, placeholder: "model ID" },
      { id: "contextWindowTokens", label: "Context tokens", limit: 10, placeholder: "required" },
      { id: "maxOutputTokens", label: "Max output tokens", limit: 10, placeholder: "required" },
      { id: "baseUrl", label: "Base URL", limit: 500, placeholder: "provider default" },
      { id: "reasoningEffort", label: "Reasoning", choices: ["", "none", "minimal", "low", "medium", "high"] },
      { id: "apiKey", label: "API key", limit: 4096, secret: true, placeholder: "keep existing key" },
    ]),
    { id: "save", label: "Save and use", action: true },
  ];
}

export function modelSettingsPatch(target, form) {
  if (target.id !== "jolo") {
    const patch = {};
    if (target.supportsModel) patch.model = form.model.trim() || null;
    if (target.supportsEffort) patch.effort = form.effort.trim() || null;
    const parsed = AgentModelPatchSchema.safeParse(patch);
    if (!parsed.success) throw new Error("Model or effort is too long or contains invalid characters.");
    return { agents: { [target.id]: parsed.data } };
  }
  if (form.name === "fake") return { provider: null };
  const parsed = ProviderSettingsSchema.safeParse({
    name: form.name, model: form.model.trim(), contextWindowTokens: Number(form.contextWindowTokens), maxOutputTokens: Number(form.maxOutputTokens),
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
    ...(form.reasoningEffort ? { reasoningEffort: form.reasoningEffort } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const label = modelFields(target, form).find((field) => field.id === issue.path[0])?.label ?? "Provider";
    throw new Error(`${label}: ${issue.message}`);
  }
  if (parsed.data.maxOutputTokens >= parsed.data.contextWindowTokens) throw new Error("Max output tokens must be smaller than the context window.");
  if (form.apiKey.trim() && (form.apiKey.trim().length < 8 || form.apiKey.trim().length > 4096)) throw new Error("API key must contain 8 to 4096 characters.");
  return { provider: parsed.data };
}

// Credentials travel only through the credential RPC, never settings, task messages, or prompt history.
export async function saveModelConfig(client, target, form) {
  const patch = modelSettingsPatch(target, form);
  const secret = target.id === "jolo" && form.name === "openai" ? form.apiKey.trim() : "";
  let stored = null;
  try {
    if (secret) stored = (await client.call("credential.set", { provider: "openai", value: secret })).stored;
    await client.call("settings.update", patch);
  } catch (error) {
    const message = secret ? String(error.message).split(secret).join("[redacted]") : error.message;
    throw new Error(`${stored ? "API key stored; model settings were not saved. " : ""}${message}`);
  }
  return `Model configuration saved · applies to the next run${stored === "session" ? " · API key lasts until the engine exits" : ""}`;
}

export function currentModelLabel(settings, session) {
  if (!settings) return "Loading model…";
  if (session?.agentId) return `${session.agentId} · ${settings.agents?.[session.agentId]?.model ?? "default"}`;
  return settings.provider && settings.provider.name !== "fake" ? settings.provider.model : "Demo provider";
}
